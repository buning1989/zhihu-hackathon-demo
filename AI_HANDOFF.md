# AI Handoff

## 2026-05-12 - v0.2 prompt assets

- Added the five v0.2 system prompt assets under `backend/app/prompts/`.
- Added `backend/app/prompt_loader.py` as a lightweight file-name based loader only.
- Added `backend/tests/test_prompt_assets.py` to verify the prompt assets and loader behavior.
- No real LLM client integration was added.
- No API keys, model calls, main business flow changes, or existing stub replacements were made.

Future LLM Client work should read these files through `prompt_loader.load_prompt(...)` and keep the current stub path untouched until real model integration is explicitly requested.
