from pathlib import Path


PROMPT_DIR = Path(__file__).resolve().parent / "prompts"


class PromptNotFoundError(FileNotFoundError):
    """Raised when a requested prompt asset does not exist."""


def load_prompt(filename: str) -> str:
    """Load a prompt asset from app/prompts by file name."""
    prompt_path = _resolve_prompt_path(filename)
    return prompt_path.read_text(encoding="utf-8")


def _resolve_prompt_path(filename: str) -> Path:
    if not filename:
        raise ValueError("Prompt filename is required.")

    file_name = Path(filename)
    if file_name.name != filename:
        raise ValueError("Prompt filename must not include path segments.")

    if file_name.suffix != ".md":
        raise ValueError("Prompt filename must be a Markdown file.")

    prompt_path = PROMPT_DIR / file_name
    if not prompt_path.is_file():
        raise PromptNotFoundError(f"Prompt asset not found: {filename}")

    return prompt_path
