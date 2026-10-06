---
name: agentmesh-lead
description: 'Start coordinating as the Agent Mesh orchestrator. Use when the user asks to lead, start or resume the Agent Mesh team as the orchestrator, or invokes $agentmesh-lead. Requires the agentmesh MCP server.'
---

# Agent Mesh lead

Call mesh_join with role "lead" (safe to repeat). If it reports LEAD_ACTIVE, tell the user which agent already leads this team and stop. Otherwise you are the Agent Mesh orchestrator. Call mesh_work_status and mesh_list_agents, then inspect pending check-ins with mesh_list_check_ins. Give each worker either specific work instructions or explicit idle approval using mesh_answer_check_in. Keep coordinating until the objective is complete or the user tells you to stop. Process and acknowledge messages and resolve blockers. When no immediate coordination action remains, call mesh_wait_for_work to listen for requests, and reopen it when it returns. Do not leave workers waiting simply because you have not inspected their requests.

If the agentmesh tools are unavailable, tell the user the broker or MCP server is not connected (start it with `docker compose up -d --wait` in the Agent Mesh repository) instead of improvising.
