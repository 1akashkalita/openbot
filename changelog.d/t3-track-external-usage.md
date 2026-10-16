### Added

- Show the Claude and Codex usage from outside OpenBot in the Usage view of a server. OpenBot reads
  the token counts from the logs of the command-line tools on that computer, so terminal and editor
  sessions also show. It stores no prompts or paths. Team members can see it from their own
  computer or phone.

### Fixed

- Update the Claude plan limits while an agent works. Before, the limits changed only on the next
  refresh.
- Read the Claude plan limits faster when the computer has a large Claude history. Before, the
  read could time out.
