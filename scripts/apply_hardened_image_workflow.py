import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW_PATH = ROOT / "agents/n8n/workflows/algemeen/image-generator-litellm.json"
SOURCE_PATH = ROOT / "scripts/harden-image-workflow.js"


def extract_code(source: str, node_variable: str) -> str:
    pattern = rf"{node_variable}\.parameters\.jsCode = String\.raw`(.*?)`;"
    match = re.search(pattern, source, re.DOTALL)
    if not match:
        raise ValueError(f"Could not extract code for {node_variable}")
    return match.group(1)


def main() -> None:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    prepare_code = extract_code(source, "prepareNode")
    response_code = extract_code(source, "responseNode")

    document = json.loads(WORKFLOW_PATH.read_text(encoding="utf-8"))
    workflow = document[0] if isinstance(document, list) else document
    nodes = {node.get("name"): node for node in workflow.get("nodes", [])}
    required = {"Prepare Image Request", "Call Images API", "Build Image Response"}
    if not required.issubset(nodes):
        raise ValueError("Required image workflow nodes are missing")

    nodes["Prepare Image Request"].setdefault("parameters", {})["jsCode"] = prepare_code
    call_parameters = nodes["Call Images API"].setdefault("parameters", {})
    nodes["Call Images API"]["continueOnFail"] = True
    call_parameters.setdefault("options", {})["timeout"] = 180000
    nodes["Build Image Response"].setdefault("parameters", {})["jsCode"] = response_code

    settings = workflow.setdefault("settings", {})
    settings.update(
        {
            "executionOrder": "v1",
            "callerPolicy": "workflowsFromSameOwner",
            "saveDataSuccessExecution": "none",
            "saveManualExecutions": False,
        }
    )
    WORKFLOW_PATH.write_text(json.dumps(document, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("Hardened image workflow owner, input, response and storage handling")


if __name__ == "__main__":
    main()
