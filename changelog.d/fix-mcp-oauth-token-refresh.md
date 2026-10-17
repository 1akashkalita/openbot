### Fixed

- Agents keep the tools of an MCP server that you signed in to, such as Vercel, after the access token expires. Before, a long agent session kept the first token, and the server refused every call after about one hour. Now each call goes through a local address on this computer that adds the current token and renews it when the server refuses it. A Codex agent that uses such a server starts one new session after the update and keeps its conversation history.
