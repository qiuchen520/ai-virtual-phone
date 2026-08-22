// lib/stream-preview.ts
// 流式生成预览的文本净化：AI 回复里混着富媒体指令（[状态栏]/[内心]/[照片]）、
// 工具标签（[执行动作]/[获取指令]）等不直接给用户看的协议内容。流式增量是碎片，
// 标签可能未闭合，所以这里做的是「幂等净化」——对完整累积文本反复应用也安全：
// 已经剥掉的不会再剥，未闭合的标签残留会在下一批增量到来时随全文重算被清掉。

import { stripTextToolDirectives } from "./text-tool-protocol";

const TOOL_DIRECTIVE_START_RE = /\[[^\]\r\n]*?(?:执行动作|获取指令|获取工具|工具调用)\s*[:：]/;
const MEDIA_DIRECTIVE_RE = /\[(?:代付请求|音乐分享|语音条|表情包|照片|红包|转账|位置|名片|音乐|礼物)\s*[:：][^\]\r\n]*\]/g;
const INCOMPLETE_MEDIA_DIRECTIVE_RE = /\[(?:代付请求|音乐分享|语音条|表情包|照片|红包|转账|位置|名片|音乐|礼物)\s*[:：][^\]\r\n]*$/g;

/** 剥掉不在气泡正文里展示的协议标签，保留对话正文（含群聊 [角色名]: 前缀） */
export function cleanStreamText(raw: string): string {
    if (!raw) return "";
    let text = raw;
    // 成对富媒体块整块剥掉
    text = text.replace(/\[状态栏\][\s\S]*?\[\/状态栏\]/gi, "");
    text = text.replace(/\[内心\][\s\S]*?\[\/内心\]/gi, "");
    // 单边开标签（还没闭合）也剥掉，避免预览里露出协议残片
    text = text.replace(/\[状态栏\][\s\S]*?$/gi, "");
    text = text.replace(/\[内心\][\s\S]*?$/gi, "");
    // 工具指令参数允许嵌套数组、括号及字符串里的 ]，复用项目统一解析器，不能用 [^]] 截断。
    text = stripTextToolDirectives(text);
    const incompleteTool = text.match(TOOL_DIRECTIVE_START_RE);
    if (incompleteTool?.index !== undefined) text = text.slice(0, incompleteTool.index);
    // 富媒体完整标签显示为附件占位；尚未闭合时也隐藏协议正文。
    text = text.replace(MEDIA_DIRECTIVE_RE, "📎 ");
    text = text.replace(INCOMPLETE_MEDIA_DIRECTIVE_RE, "📎 ");
    // 引用壳只隐藏标签，保留后面的实际回复。
    text = text.replace(/\[引用\s*[:：][^\]\r\n]*\]/g, "");
    text = text.replace(/\[引用\s*[:：][^\]\r\n]*$/g, "");
    // 动作标签（朋友圈/发帖/静默等）与拍一拍通知不进入正文预览。
    text = text.replace(/\[(?:发朋友圈|发微博|发帖|静默|骰子|领取红包|拒收红包|接受转账|领取转账|拒收转账|接受代付|拒绝代付)[^\]\r\n]*\]/g, "");
    text = text.replace(/\[[^\]\r\n]{0,32}拍了拍[^\]\r\n]*\]/g, "");
    // 行内状态值支持中文字段名，同时保留群聊的 [角色名]: 前缀。
    text = text.replace(/\[[^\]\r\n：:]{1,24}\s*[:：]\s*-?\d+(?:\.\d+)?\s*\]/g, "");
    // 压缩多余空行
    text = text.replace(/\n{3,}/g, "\n\n").trim();
    return text;
}
