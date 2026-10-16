# Launch one configured native executable inside a Windows Job Object.
# Closing this helper (including broker crash/cancellation) kills every child.
# Arguments are encoded for CreateProcessW; no cmd.exe shell is involved.
param([Parameter(Mandatory=$true)][string]$Descriptor, [string]$CancelFile = '')
$ErrorActionPreference = 'Stop'
$launch = Get-Content -LiteralPath $Descriptor -Raw | ConvertFrom-Json
$startup = Join-Path (Split-Path -LiteralPath $Descriptor) 'job-status.json'
[System.IO.File]::WriteAllText($startup, '{"stage":"compiling-helper"}')
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Collections.Generic;
using System.IO;
using System.Globalization;
public static class MltWindowsJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct CpuLimits { public uint ControlFlags, CpuRate; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo { public uint cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX,dwY,dwXSize,dwYSize,dwXCountChars,dwYCountChars,dwFillAttribute,dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput,hStdOutput,hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr hProcess,hThread; public uint dwProcessId,dwThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr data,uint size,IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool belongs);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupInfo si,out ProcessInfo pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool success) { if(!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static void Stage(string telemetry,string stage) {
    string file=Path.Combine(Path.GetDirectoryName(telemetry),"job-status.json");
    try { File.WriteAllText(file,"{\"stage\":\""+stage+"\"}"); } catch(IOException) {} catch(UnauthorizedAccessException) {}
  }
  static string Quote(string arg) {
    var result = new StringBuilder("\""); int slashes=0;
    foreach(char c in arg) { if(c=='\\') { slashes++; continue; } if(c=='\"') result.Append('\\',slashes*2+1); else result.Append('\\',slashes); result.Append(c); slashes=0; }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  static readonly Dictionary<int,Tuple<long,double>> previous = new Dictionary<int,Tuple<long,double>>();
  static long sampledAt;
  // Query only this Job Object. PID reuse cannot admit an unrelated process.
  static void Sample(IntPtr job,string destination) {
    const int maximum=128; int size=8+IntPtr.Size*maximum; IntPtr data=Marshal.AllocHGlobal(size);
    try {
      if(!QueryInformationJobObject(job,3,data,(uint)size,IntPtr.Zero)) return;
      long now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); double elapsed=now-sampledAt;
      int count=Math.Min(maximum,Marshal.ReadInt32(data,4)); var rows=new List<string>(); var next=new Dictionary<int,Tuple<long,double>>();
      for(int i=0;i<count;i++) {
        int pid=Marshal.ReadIntPtr(data,8+i*IntPtr.Size).ToInt32();
        try {
          using(var process=Process.GetProcessById(pid)) {
            bool belongs; if(!IsProcessInJob(process.Handle,job,out belongs)||!belongs) continue;
            long started=process.StartTime.ToUniversalTime().Ticks; double cpu=process.TotalProcessorTime.TotalMilliseconds; Tuple<long,double> prior;
            string percent="null";
            if(elapsed>0 && previous.TryGetValue(pid,out prior) && prior.Item1==started) percent=Math.Max(0,Math.Min(100,(cpu-prior.Item2)/elapsed/Environment.ProcessorCount*100)).ToString("F2",CultureInfo.InvariantCulture);
            next[pid]=Tuple.Create(started,cpu);
            rows.Add("{\"pid\":"+pid+",\"memoryMb\":"+(process.WorkingSet64/1048576.0).ToString("F2",CultureInfo.InvariantCulture)+",\"cpuPercent\":"+percent+"}");
          }
        } catch(System.ArgumentException) {} catch(System.InvalidOperationException) {} catch(System.ComponentModel.Win32Exception) {}
      }
      previous.Clear(); foreach(var item in next) previous[item.Key]=item.Value; sampledAt=now;
      string temp=destination+".tmp"; File.WriteAllText(temp,"{\"sampledAt\":"+now+",\"processes\":["+String.Join(",",rows)+"]}");
      if(File.Exists(destination)) File.Replace(temp,destination,null); else File.Move(temp,destination);
    } catch(IOException) {} catch(UnauthorizedAccessException) {} finally { Marshal.FreeHGlobal(data); }
  }
  // The helper reports completion only after its anonymous Job has no active processes.
  static void Retire(IntPtr job) {
    Check(TerminateJobObject(job,1));
    IntPtr accounting=Marshal.AllocHGlobal(48);
    try {
      for(int i=0;i<200;i++) {
        Check(QueryInformationJobObject(job,1,accounting,48,IntPtr.Zero));
        if(Marshal.ReadInt32(accounting,40)==0) return;
        System.Threading.Thread.Sleep(10);
      }
      throw new TimeoutException("Owned Job did not finish retiring its processes.");
    } finally { Marshal.FreeHGlobal(accounting); }
  }
  public static int Run(string file,string[] args,string cwd,ulong memoryMb,uint cpuPercent,uint processLimit,string telemetry,string cancel) {
    IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
    ProcessInfo pi=new ProcessInfo();
    try {
      var limits=new ExtendedLimits(); limits.BasicLimitInformation.LimitFlags=0x2000;
      if(processLimit>0) { limits.BasicLimitInformation.LimitFlags|=0x8; limits.BasicLimitInformation.ActiveProcessLimit=processLimit; }
      if(memoryMb>0) { limits.BasicLimitInformation.LimitFlags|=0x200; limits.JobMemoryLimit=new UIntPtr(memoryMb*1048576); }
      int size=Marshal.SizeOf(limits); IntPtr data=Marshal.AllocHGlobal(size);
      try { Marshal.StructureToPtr(limits,data,false); Check(SetInformationJobObject(job,9,data,(uint)size)); } finally { Marshal.FreeHGlobal(data); }
      if(cpuPercent>0 && cpuPercent<100) { var cpu=new CpuLimits { ControlFlags=5, CpuRate=cpuPercent*100 }; size=Marshal.SizeOf(cpu); data=Marshal.AllocHGlobal(size); try { Marshal.StructureToPtr(cpu,data,false); Check(SetInformationJobObject(job,15,data,(uint)size)); } finally { Marshal.FreeHGlobal(data); } }
      var si=new StartupInfo { cb=(uint)Marshal.SizeOf(typeof(StartupInfo)), dwFlags=0x100, hStdInput=GetStdHandle(-10), hStdOutput=GetStdHandle(-11), hStdError=GetStdHandle(-12) };
      if(cancel.Length>0 && File.Exists(cancel)) return 1;
      var command=new StringBuilder(Quote(file)); foreach(string arg in args) command.Append(' ').Append(Quote(arg));
      Stage(telemetry,"creating-host");
      Check(CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out pi));
      try { Check(AssignProcessToJobObject(job,pi.hProcess)); } catch { TerminateProcess(pi.hProcess,1); throw; }
      ResumeThread(pi.hThread);
      Stage(telemetry,"host-resumed");
      Sample(job,telemetry);
      long nextSample=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()+2000;
      while(WaitForSingleObject(pi.hProcess,100)==258) {
        if(cancel.Length>0 && File.Exists(cancel)) { Retire(job); break; }
        long now=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if(now>=nextSample) { Sample(job,telemetry); nextSample=now+2000; }
      }
      uint code; Check(GetExitCodeProcess(pi.hProcess,out code)); Retire(job); return unchecked((int)code);
    } finally { if(pi.hThread!=IntPtr.Zero) CloseHandle(pi.hThread); if(pi.hProcess!=IntPtr.Zero) CloseHandle(pi.hProcess); CloseHandle(job); }
  }
}
'@
$telemetry = Join-Path (Split-Path -LiteralPath $Descriptor) 'resources.json'
[System.IO.File]::WriteAllText($startup, '{"stage":"entering-native-job"}')
exit [MltWindowsJob]::Run([string]$launch.file, [string[]]$launch.args, [string]$launch.cwd, [uint64]$launch.memoryMb, [uint32]$launch.cpuPercent, [uint32]$launch.processLimit, $telemetry, $CancelFile)
