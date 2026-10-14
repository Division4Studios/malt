# Launch one configured native executable inside a Windows Job Object.
# Closing this helper (including broker crash/cancellation) kills every child.
# Arguments are encoded for CreateProcessW; no cmd.exe shell is involved.
param([Parameter(Mandatory=$true)][string]$Descriptor)
$ErrorActionPreference = 'Stop'
$launch = Get-Content -LiteralPath $Descriptor -Raw | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
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
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref StartupInfo si,out ProcessInfo pi);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool success) { if(!success) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string arg) {
    var result = new StringBuilder("\""); int slashes=0;
    foreach(char c in arg) { if(c=='\\') { slashes++; continue; } if(c=='\"') result.Append('\\',slashes*2+1); else result.Append('\\',slashes); result.Append(c); slashes=0; }
    result.Append('\\',slashes*2); result.Append('"'); return result.ToString();
  }
  public static int Run(string file,string[] args,string cwd,ulong memoryMb,uint cpuPercent,uint processLimit) {
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
      var command=new StringBuilder(Quote(file)); foreach(string arg in args) command.Append(' ').Append(Quote(arg));
      Check(CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out pi));
      try { Check(AssignProcessToJobObject(job,pi.hProcess)); } catch { TerminateProcess(pi.hProcess,1); throw; }
      ResumeThread(pi.hThread); WaitForSingleObject(pi.hProcess,0xffffffff); uint code; Check(GetExitCodeProcess(pi.hProcess,out code)); return unchecked((int)code);
    } finally { if(pi.hThread!=IntPtr.Zero) CloseHandle(pi.hThread); if(pi.hProcess!=IntPtr.Zero) CloseHandle(pi.hProcess); CloseHandle(job); }
  }
}
'@
exit [MltWindowsJob]::Run([string]$launch.file, [string[]]$launch.args, [string]$launch.cwd, [uint64]$launch.memoryMb, [uint32]$launch.cpuPercent, [uint32]$launch.processLimit)
