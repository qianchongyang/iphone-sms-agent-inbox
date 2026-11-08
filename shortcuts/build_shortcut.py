"""Build a private upload shortcut. Read the upload secret from stdin, never arguments."""
import json
import os
import pathlib
import plistlib
import sys
import uuid

root = pathlib.Path(__file__).resolve().parent
config = json.load(sys.stdin)
from urllib.parse import urlparse
origin = config["origin"].rstrip("/")
parsed = urlparse(origin)
if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
    raise ValueError("origin must be an HTTPS origin without path or credentials")
if len(config.get("upload_token", "")) < 32:
    raise ValueError("upload_token must have at least 32 characters")
root = pathlib.Path(config.get("output_dir", root)).resolve()
root.mkdir(parents=True, exist_ok=True)


def text(value):
    return {"WFSerializationType": "WFTextTokenString", "Value": {"string": value, "attachmentsByRange": {}}}


def variable(value):
    return {"WFSerializationType": "WFTextTokenString", "Value": {"string": "\ufffc", "attachmentsByRange": {"{0, 1}": value}}}


def dictionary(items):
    return {"WFSerializationType": "WFDictionaryFieldValue", "Value": {"WFDictionaryFieldValueItems": [
        {"WFItemType": 0, "WFKey": text(k), "WFValue": v if isinstance(v, dict) else text(v)} for k, v in items.items()
    ]}}


text_id = str(uuid.uuid4()).upper()
upload_id = str(uuid.uuid4()).upper()
actions = [
    {"WFWorkflowActionIdentifier": "is.workflow.actions.comment", "WFWorkflowActionParameters": {
        "WFCommentActionText": "将自动化传入的信息正文上传至你自己的 " + origin + "。仅展示最近10分钟。请勿分享本快捷指令，其中包含仅用于上传的密钥。"}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.gettext", "WFWorkflowActionParameters": {
        "WFTextActionText": variable({"Type": "ExtensionInput"}), "UUID": text_id}},
    {"WFWorkflowActionIdentifier": "is.workflow.actions.downloadurl", "WFWorkflowActionParameters": {
        "WFURL": origin + "/api/sms", "WFHTTPMethod": "POST", "WFHTTPBodyType": "JSON",
        "WFHTTPHeaders": dictionary({"Authorization": "Bearer " + config["upload_token"]}),
        "WFJSONValues": dictionary({"message": variable({"Type": "ActionOutput", "OutputUUID": text_id, "OutputName": "文本"})}),
        "UUID": upload_id}},
]
workflow = {
    "WFWorkflowActions": actions, "WFWorkflowClientVersion": "4046.0.2.2.3",
    "WFWorkflowMinimumClientVersion": 900, "WFWorkflowMinimumClientVersionString": "900",
    "WFWorkflowIcon": {"WFWorkflowIconStartColor": 4282601983, "WFWorkflowIconGlyphNumber": 59777},
    "WFWorkflowInputContentItemClasses": ["WFStringContentItem", "WFMessageContentItem"],
    "WFWorkflowOutputContentItemClasses": [], "WFWorkflowTypes": ["ActionExtension"],
    "WFWorkflowImportQuestions": [], "WFQuickActionSurfaces": [],
    "WFWorkflowHasShortcutInputVariables": True, "WFWorkflowHasOutputFallback": False,
}
out = root / "验证码上传.unsigned.shortcut"
out.write_bytes(plistlib.dumps(workflow, fmt=plistlib.FMT_BINARY))
os.chmod(out, 0o600)
print("Private shortcut generated; upload secret not printed.")
