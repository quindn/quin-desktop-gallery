# CLAUDE.md

Every project rule, workflow and pointer lives in `AGENTS.md`, shared with other AI tools. It is imported here:

@AGENTS.md

## Claude Code specifics

- Reply to the owner in Vietnamese.
- Use `run_in_background` for release builds and long e2e runs, and wait for the notification instead of polling.
- Before saying a feature works, verify it with the real app (`tests-e2e/`), not only unit tests.
