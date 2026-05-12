import importlib.util
import unittest
from pathlib import Path


BACKEND_DIR = Path(__file__).resolve().parents[1]
PROMPTS_DIR = BACKEND_DIR / "app" / "prompts"
PROMPT_LOADER_PATH = BACKEND_DIR / "app" / "prompt_loader.py"

EXPECTED_PROMPTS = {
    "planner_system.md": [
        "search_axes",
        "query_terms_policy",
        "do_not_copy_example_terms_unless_relevant",
    ],
    "evidence_extractor_system.md": [
        "first_person_audit",
        "support_map",
        "evidence_audit",
        "recommended_card_type",
    ],
    "repair_planner_system.md": [
        "scarce_should_go_to_build_prompt",
        "repair_once_for_narrow_results",
        "dedupe_against_existing_queries",
    ],
    "card_composer_system.md": [
        "text_support",
        "display_quality",
        "actions",
        "模型输出中不要包含 actions 字段",
    ],
    "grounded_qa_system.md": [
        "question_scope",
        "evidence_policy",
        "answer_type=insufficient_evidence",
        "answer_type 必须为 out_of_scope",
    ],
}


def load_prompt_loader_module():
    spec = importlib.util.spec_from_file_location(
        "prompt_loader",
        PROMPT_LOADER_PATH,
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PromptAssetsTest(unittest.TestCase):
    def test_v02_prompt_files_exist(self):
        for filename, markers in EXPECTED_PROMPTS.items():
            with self.subTest(filename=filename):
                prompt_path = PROMPTS_DIR / filename
                self.assertTrue(prompt_path.is_file())

                prompt_text = prompt_path.read_text(encoding="utf-8")
                self.assertGreater(len(prompt_text), 500)
                self.assertNotIn("v0.1", prompt_text)
                self.assertFalse(prompt_text.lstrip().startswith("```"))
                self.assertFalse(prompt_text.rstrip().endswith("```"))

                for marker in markers:
                    self.assertIn(marker, prompt_text)

    def test_prompt_loader_reads_prompt_by_filename(self):
        prompt_loader = load_prompt_loader_module()

        loaded_prompt = prompt_loader.load_prompt("planner_system.md")
        expected_prompt = (PROMPTS_DIR / "planner_system.md").read_text(
            encoding="utf-8",
        )

        self.assertEqual(loaded_prompt, expected_prompt)

    def test_prompt_loader_rejects_path_segments(self):
        prompt_loader = load_prompt_loader_module()

        with self.assertRaises(ValueError):
            prompt_loader.load_prompt("../README.md")

    def test_prompt_loader_rejects_unknown_file(self):
        prompt_loader = load_prompt_loader_module()

        with self.assertRaises(prompt_loader.PromptNotFoundError):
            prompt_loader.load_prompt("missing_system.md")


if __name__ == "__main__":
    unittest.main()
