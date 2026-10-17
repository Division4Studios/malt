---
name: agentmesh-lead
description: 'Start coordinating as the MALT orchestrator. Use when the user asks to lead, start or resume the MALT team as the orchestrator, or invokes $agentmesh-lead. Requires the agentmesh MCP server.'
---

# MALT lead

Call mesh_join with role "lead" (safe to repeat). If it reports LEAD_ACTIVE, tell the user which agent already leads this team and stop. Otherwise you are the MALT orchestrator. Call mesh_work_status and mesh_list_agents, then inspect pending check-ins with mesh_list_check_ins. Before assigning or starting any issue, check active MALT claims and jobs, other sessions and worktrees, and fetch the latest main; if the issue is closed, already fixed on main, covered by a different open PR or claimed by another session or developer, report that to the user instead of assigning it. Reviewing, repairing or verifying the same delivery is not duplicate work. Give each worker either specific work instructions or explicit idle approval using mesh_answer_check_in. Keep coordinating until the objective is complete or the user tells you to stop. Process and acknowledge messages and resolve blockers. When no immediate coordination action remains, call mesh_wait_for_work to listen for requests, and reopen it when it returns. Do not leave workers waiting simply because you have not inspected their requests.

If the agentmesh tools are unavailable, tell the user the broker or MCP server is not connected (start it with `docker compose up -d --wait` in the MALT repository) instead of improvising.
