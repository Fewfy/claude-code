export const DISCOVER_SKILLS_TOOL_NAME = 'DiscoverSkills'

export const DESCRIPTION =
  'Search for relevant skills by describing what you want to do'

export const DISCOVER_SKILLS_PROMPT = `Search for skills relevant to a task description. Returns matching skills ranked by relevance.

Input:
- query: what you want to do. Be specific — e.g. "deploy a Next.js app to Cloudflare Workers" rather than "deploy".
- limit: maximum number of results (default 5).
- description: deprecated alias for "query"; prefer "query".

Use this when:
- The auto-surfaced skills don't cover your current task
- You're pivoting to a different kind of work mid-conversation
- You want to find specialized skills for an unusual workflow

The search uses TF-IDF keyword matching against all registered skills (bundled, user-defined, and MCP-provided). Results include skill name, description, and relevance score.`
