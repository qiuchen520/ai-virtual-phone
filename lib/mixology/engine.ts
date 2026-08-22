// lib/mixology/engine.ts
// 独家特调 · 对局运行时：开局、出杯（生成回复）、重说、继续。
//
// 特调不走聊天预设/正则管线——一杯特调自带全部提示词，正文协议由 App 自有解析器处理。
// API 走全局默认接口配置（与角色绑定无关，特调对局是独立世界）。

import { ChatEngineError, sendLLMRequest, sendLLMStreamRequest } from "../chat-engine";
import type { LLMMessage } from "../llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig } from "../settings-storage";
import type { ApiConfig } from "../settings-types";
import { applyMixMacros, assembleMixPrompt, MIX_DEFAULT_USER_NAME, MIX_ENCORE_CLOSE, MIX_ENCORE_OPEN, MIX_TICKET_CLOSE, MIX_TICKET_OPEN, mixNamedOpen, type MixAssembledPrompt } from "./assembler";
import { applyMixFilterRules, extractMixBlocks, type MixExtractedBlock } from "./prose";
import {
    getMixMaterial,
    getMixSession,
    resolveMixRecipeMaterials,
    saveMixSession,
} from "./storage";
import {
    createMixId,
    mixSlotEntries,
    mixSlotFirstId,
    mixTurnEncoreBlocks,
    mixTurnTicketBlocks,
    type MixCharacterCard,
    type MixEncoreMaterial,
    type MixMaterial,
    type MixMechanismMaterial,
    type MixState,
    type MixMaterialKind,
    type MixRecipe,
    type MixSession,
    type MixTicketMaterial,
    type MixTurn,
    type MixTurnBlock,
} from "./types";
import {
    advanceMixState,
    buildMixConditionContext,
    initialMixState,
    pickActiveMixMaterials,
    rollbackMixState,
} from "./state";
import { mergeHookState, type MixHook, type MixHookPayload } from "./mechanism-protocol";
import { disposeMixSandboxes, runMixHook } from "./mechanism-runtime";

export const MIX_PROMPT_APP_ID = "mixology";
const MIX_PROMPT_TAGS = ["mixology"];

/** 对局用的 API 配置：全局默认接口 */
export function resolveMixApiConfig(): ApiConfig | null {
    const binding = loadBindingConfig();
    const configs = loadApiConfigs();
    const id = binding.globalDefaults.apiConfigId;
    if (id) {
        const found = configs.find((c) => c.id === id);
        if (found) return found;
    }
    return configs[0] ?? null;
}

/** 从方案快照装配提示词（材料从酒柜按 id 现取；角色卡被删则报错） */
function assembleFromSession(session: MixSession): {
    prompt: MixAssembledPrompt;
    /** 本轮生效的小票/尾调（条件筛过、按槽位顺序）——每件各自成块 */
    tickets: MixTicketMaterial[];
    encores: MixEncoreMaterial[];
    active: Partial<Record<MixMaterialKind, MixMaterial[]>>;
} {
    const { entries } = resolveMixRecipeMaterials(session.recipe);
    const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
    const character = active.character?.[0];
    if (!character || character.kind !== "character") {
        throw new ChatEngineError("这杯特调的角色卡已不在酒柜里，无法继续对局。");
    }
    const prompt = assembleMixPrompt({
        character: character as MixCharacterCard,
        materials: active,
        userName: session.userName,
        openingIndex: session.openingIndex,
        state: session.state,
    });
    const tickets = (active.ticket ?? []).filter((m): m is MixTicketMaterial => m.kind === "ticket");
    const encores = (active.encore ?? []).filter((m): m is MixEncoreMaterial => m.kind === "encore");
    return { prompt, tickets, encores, active };
}

/**
 * 一块壳内原文还原成带标记的整块。named = 这一轮不止一块，开标签要带名字
 * （名字按块的供稿材料 id 现取；材料被删就退回不具名的壳）。
 */
function blockText(open: string, close: string, block: MixTurnBlock, named: boolean): string {
    const name = named && block.id ? getMixMaterial(block.id)?.name?.trim() : undefined;
    return `${name ? mixNamedOpen(open, name) : open}\n${block.raw}\n${close}`;
}

/**
 * 还原一条消息的"原始输出"：assistant 轮把剥掉的状态栏/小剧场块拼回去。
 * 历史回放与「编辑原始输出」共用——编辑时看到的就是模型当初写的完整样子。
 */
export function mixTurnRawText(turn: MixTurn): string {
    if (turn.role !== "assistant") return turn.text;
    // 顺序与输出要求一致：状态栏在正文前、小剧场在正文后——历史回放就是模型的"输出习惯"示范
    const tickets = mixTurnTicketBlocks(turn);
    const encores = mixTurnEncoreBlocks(turn);
    return [
        ...tickets.map((b) => blockText(MIX_TICKET_OPEN, MIX_TICKET_CLOSE, b, tickets.length > 1)),
        turn.text,
        ...encores.map((b) => blockText(MIX_ENCORE_OPEN, MIX_ENCORE_CLOSE, b, encores.length > 1)),
    ].filter(Boolean).join("\n\n");
}

/** 历史回传裁决：这一块的壳内原文要不要回传给模型（按块的供稿材料各自定） */
type MixFeedResolver = (kind: "ticket" | "encore", materialId: string | undefined) => "latest" | "all" | "none";

/**
 * 历史回放：默认只有最近一条 assistant 轮补回状态栏/小剧场块。
 * 模型需要的只有两样——最新状态的接续（契约的变化规则只依赖上一轮的值）
 * 和一份格式示范（防掉格式），最后一块两者都够；更旧的块随轮数线性膨胀，
 * 是纯 token 负担（按信息量基准每轮各两三百字，长局能省上万字符）。
 * 材料自己可改档（按块裁决，多块互不牵连）：all = 它的往期块逐轮回传；
 * none = 连最近一轮都不回传，一个字不占。存储不动：块原文原样留着，
 * 界面回放与编辑不受影响。
 */
function turnToHistoryContent(turn: MixTurn, isLast: boolean, feedOf?: MixFeedResolver): string {
    if (turn.role !== "assistant") return turn.text;
    const tickets = mixTurnTicketBlocks(turn);
    const encores = mixTurnEncoreBlocks(turn);
    const keep = (kind: "ticket" | "encore") => (b: MixTurnBlock) => {
        const feed = feedOf?.(kind, b.id) ?? "latest";
        return feed === "all" || (isLast && feed !== "none");
    };
    return [
        ...tickets.filter(keep("ticket")).map((b) => blockText(MIX_TICKET_OPEN, MIX_TICKET_CLOSE, b, tickets.length > 1)),
        turn.text,
        ...encores.filter(keep("encore")).map((b) => blockText(MIX_ENCORE_OPEN, MIX_ENCORE_CLOSE, b, encores.length > 1)),
    ].filter(Boolean).join("\n\n");
}

function buildMixMessages(
    session: MixSession,
    assembled: MixAssembledPrompt,
    extraUserNudge?: string,
    feedOf?: MixFeedResolver,
): LLMMessage[] {
    const messages: LLMMessage[] = [
        { role: "system", content: assembled.system, _debugMeta: { marker: "mixology_system" } },
    ];
    let lastAssistantIdx = -1;
    for (let i = session.turns.length - 1; i >= 0; i -= 1) {
        if (session.turns[i].role === "assistant") { lastAssistantIdx = i; break; }
    }
    for (const [i, turn] of session.turns.entries()) {
        messages.push({
            role: turn.role,
            content: turnToHistoryContent(turn, i === lastAssistantIdx, feedOf),
            _debugMeta: { marker: "mixology_history", _fromHistory: true },
        });
    }
    if (assembled.postHistory) {
        messages.push({
            role: "system",
            content: assembled.postHistory,
            _debugMeta: { marker: "mixology_strength" },
        });
    }
    if (extraUserNudge) {
        messages.push({
            role: "user",
            content: extraUserNudge,
            _debugMeta: { marker: "mixology_nudge" },
        });
    }
    return messages;
}

/** 开局：按方案快照建对局，开场白作为首条 assistant 消息 */
export function startMixSession(
    recipe: MixRecipe,
    options?: { openingIndex?: number; userName?: string },
): MixSession {
    const characterId = mixSlotFirstId(recipe.slots, "character");
    const card = characterId ? getMixMaterial(characterId) : null;
    if (!card || card.kind !== "character") {
        throw new ChatEngineError("特调里没有角色卡，装不满这一杯。");
    }
    // 用户的名字：显式传入 > 面具材料里填的（装配器同规则，这里快照进对局供界面用）
    const personaId = mixSlotFirstId(recipe.slots, "persona");
    const personaMat = personaId ? getMixMaterial(personaId) : null;
    const personaUserName = personaMat?.kind === "persona" ? personaMat.userName?.trim() : undefined;
    const openingIndex = options?.openingIndex ?? 0;
    // 记住的值的开局初值：全部小票里声明过初始值的项（同名先声明的优先）
    const ticketMats = mixSlotEntries(recipe.slots, "ticket")
        .map((entry) => getMixMaterial(entry.materialId))
        .filter((m): m is MixTicketMaterial => m?.kind === "ticket");
    const session: MixSession = {
        id: createMixId("mixsess"),
        recipe: { ...recipe, slots: { ...recipe.slots } },
        charName: card.charName.trim() || card.name,
        userName: options?.userName?.trim() || personaUserName || undefined,
        openingIndex,
        turns: [],
        state: initialMixState(ticketMats),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    const assembled = assembleFromSession(session).prompt;
    if (assembled.opening) {
        session.turns.push({
            id: createMixId("mixturn"),
            role: "assistant",
            text: assembled.opening,
            createdAt: Date.now(),
        });
    }
    saveMixSession(session);
    return session;
}

/**
 * 开局钩子：建局之后单独跑一次，让机括初始化自己的存储与记住的值。
 * 刻意不塞进 startMixSession——那是同步函数，界面靠它立刻拿到对局跳转；
 * 钩子是异步的，让它在后台补一笔，跑完再落库。跑失败也不影响开局。
 */
export async function runMixSessionStart(sessionId: string): Promise<void> {
    const session = getMixSession(sessionId);
    if (!session) return;
    const result = await runMechanismHooks(session, "sessionStart", {});
    const latest = getMixSession(sessionId);
    if (!latest) return;
    const nextState = mergeHookState(latest.state ?? {}, result.state);
    const changed = JSON.stringify(nextState) !== JSON.stringify(latest.state ?? {})
        || JSON.stringify(result.store) !== JSON.stringify(latest.mechanismStore ?? {});
    if (!changed) return;
    saveMixSession({ ...latest, state: nextState, mechanismStore: result.store });
}

/**
 * 收摊钩子：退出对局时跑一次，顺手把这一局的沙盒全收掉。
 * 收摊的返回值只认存储与记住的值——这时候改正文已经没有意义了。
 */
export async function runMixSessionEnd(sessionId: string): Promise<void> {
    const session = getMixSession(sessionId);
    if (session) {
        try {
            const result = await runMechanismHooks(session, "sessionEnd", {});
            const latest = getMixSession(sessionId);
            if (latest) {
                saveMixSession({
                    ...latest,
                    state: mergeHookState(latest.state ?? {}, result.state),
                    mechanismStore: result.store,
                });
            }
        } catch {
            // 收摊失败无所谓，沙盒该收还是要收
        }
    }
    disposeMixSandboxes(sessionId);
}

export type MixReplyResult = {
    session: MixSession;
    turn: MixTurn;
};

/**
 * 状态栏补写：不少模型（实测 DeepSeek）在长篇角色扮演里经常把回复末尾的
 * 状态栏块整个漏掉，提示词层面救不稳。漏块时用一次小请求单独把状态栏要
 * 回来——而且补出的块会随历史回放形成先例，后续轮次的自发服从率会明显上升。
 */
async function repairMixTicket(
    apiConfig: ApiConfig,
    session: MixSession,
    ticket: MixTicketMaterial,
    proseText: string,
    signal?: AbortSignal,
): Promise<string | undefined> {
    const charName = session.charName;
    const userName = session.userName || "你";
    const contract = applyMixMacros(ticket.contract.trim(), charName, userName);
    if (!contract) return undefined;
    const lastUser = [...session.turns].reverse().find((t) => t.role === "user")?.text ?? "";
    const messages: LLMMessage[] = [
        {
            role: "system",
            content: [
                `你在为一场角色扮演对局补写状态栏，角色是${charName}。根据本轮正文，按「输出内容」的要求逐行填写本轮的实际数据。只输出状态栏块本身，不要输出任何其他内容。`,
                "输出内容：",
                contract,
                `输出格式：第一行 ${MIX_TICKET_OPEN}，随后逐行填写，最后一行 ${MIX_TICKET_CLOSE}。`,
            ].join("\n"),
            _debugMeta: { marker: "mixology_ticket_repair" },
        },
        {
            role: "user",
            content: `${lastUser ? `本轮${userName}的发言：\n${lastUser}\n\n` : ""}本轮${charName}的正文：\n${proseText}`,
        },
    ];
    try {
        const raw = await sendLLMRequest(
            apiConfig,
            null,
            messages,
            [],
            { characterName: charName, userName },
            { appId: MIX_PROMPT_APP_ID, appTags: MIX_PROMPT_TAGS, skipOutputRegex: true, signal },
        );
        const { ticketRaw } = extractMixBlocks(raw);
        if (ticketRaw) return ticketRaw;
        // 有的模型只回数据不带壳：没有任何标签痕迹且长度合理时直接采用
        const bare = raw.trim();
        if (bare && !/[\[\]【】]/.test(bare) && bare.length < 1200) return bare;
    } catch {
        // 补写失败不拦主回复——顶多这一轮没有状态栏
    }
    return undefined;
}

/**
 * 跑一轮机括钩子。机括这一格是累加型——条件命中的几件按顺序依次跑，
 * 前一件改过的文本会交给后一件继续加工（跟风味叠加是同一个心智）。
 * 单件出错、超时、返回垃圾都只是这一件不生效，不影响别的机括，也不影响这一轮生成。
 */
async function runMechanismHooks(
    session: MixSession,
    hook: MixHook,
    input: { text?: string; ticketRaws?: string[]; encoreRaws?: string[] },
): Promise<{ text?: string; notes: string[]; state: MixState; store: Record<string, Record<string, string>> }> {
    const { entries } = resolveMixRecipeMaterials(session.recipe);
    const active = pickActiveMixMaterials(entries, buildMixConditionContext(session));
    const mechanisms = (active.mechanism ?? []).filter((m): m is MixMechanismMaterial => m.kind === "mechanism");
    const store = { ...(session.mechanismStore ?? {}) };
    const out = { text: input.text, notes: [] as string[], state: {} as MixState, store };
    if (!mechanisms.length) return out;
    for (const material of mechanisms) {
        const script = material.script?.trim();
        if (!script) continue;
        const payload: MixHookPayload = {
            hook,
            turnCount: session.turns.length,
            // 状态给的是当前值叠上前面几件机括刚写的——同一轮里后一件看得见前一件
            state: { ...(session.state ?? {}), ...out.state },
            store: store[material.id] ?? {},
            charName: session.charName,
            userName: session.userName || MIX_DEFAULT_USER_NAME,
            text: out.text,
            // 单块字段留给老机括脚本（多块时给第一块），全量走 ticketRaws/encoreRaws
            ticketRaw: input.ticketRaws?.[0],
            encoreRaw: input.encoreRaws?.[0],
            ticketRaws: input.ticketRaws,
            encoreRaws: input.encoreRaws,
        };
        const result = await runMixHook(session.id, material.id, script, hook, payload);
        if (typeof result.text === "string") out.text = result.text;
        if (result.note) out.notes.push(result.note);
        if (result.state) out.state = mergeHookState(out.state, result.state);
        if (result.store) store[material.id] = result.store;
    }
    return out;
}

/** 落杯前：给机括一次改写玩家发言、追加临时提示的机会 */
async function runBeforeSendHooks(session: MixSession, text?: string): Promise<{ session: MixSession; text?: string; note?: string }> {
    const result = await runMechanismHooks(session, "beforeSend", { text });
    const next: MixSession = {
        ...session,
        state: mergeHookState(session.state ?? {}, result.state),
        mechanismStore: result.store,
    };
    return { session: next, text: result.text, note: result.notes.join("\n") || undefined };
}

/**
 * 剥出来的块对号入座：先按开标签里的名字精确对（多块输出的正道），
 * 没名字/对不上名的按顺序补进还空着的位置（单块老格式、模型忘写名字）。
 * 块保持原文顺序返回；实在多出来的块不丢，只是没有归属（渲染退回第一件的皮）。
 */
function matchMixBlocks(blocks: MixExtractedBlock[], mats: { id: string; name: string }[]): MixTurnBlock[] {
    const used = new Set<number>();
    const assigned: (string | undefined)[] = new Array(blocks.length).fill(undefined);
    blocks.forEach((block, i) => {
        const name = block.name?.trim();
        if (!name) return;
        const at = mats.findIndex((m, j) => !used.has(j) && m.name.trim() === name);
        if (at >= 0) { used.add(at); assigned[i] = mats[at].id; }
    });
    blocks.forEach((_, i) => {
        if (assigned[i]) return;
        const at = mats.findIndex((_, j) => !used.has(j));
        if (at >= 0) { used.add(at); assigned[i] = mats[at].id; }
    });
    return blocks.map((block, i) => (assigned[i] ? { id: assigned[i], raw: block.raw } : { raw: block.raw }));
}

/** 落库前按槽位顺序归位（模型偶尔乱序）；没归属的块保持相对顺序垫在后面 */
function orderMixBlocks(blocks: MixTurnBlock[], mats: { id: string }[]): MixTurnBlock[] {
    if (blocks.length < 2) return blocks;
    const ordered: MixTurnBlock[] = [];
    for (const mat of mats) {
        const found = blocks.find((b) => b.id === mat.id);
        if (found) ordered.push(found);
    }
    for (const block of blocks) {
        if (!ordered.includes(block)) ordered.push(block);
    }
    return ordered;
}

/**
 * 用这一轮的块推进记住的值：每张小票只认自己那块的原文。
 * 单张小票时没归属的块也算它的（老格式输出没有名字）。
 */
function advanceMixStateWithBlocks(
    prev: MixState | undefined,
    tickets: MixTicketMaterial[],
    blocks: MixTurnBlock[],
): MixState {
    let state: MixState = { ...(prev ?? {}) };
    for (const ticket of tickets) {
        // 只有一张小票时不挑归属：块是谁供的稿都拿来抽值（老格式、退役皮的块照样认）
        const block = blocks.find((b) => b.id === ticket.id)
            ?? (tickets.length === 1 ? blocks[0] : undefined);
        state = advanceMixState(state, ticket, block?.raw);
    }
    return state;
}

/**
 * 历史回传裁决器：按块的供稿材料查它的 historyFeed 设置。
 * 材料从方案槽位全量收（不只本轮生效的）——往期块的供稿材料这一轮可能条件不满足，
 * 它的设置照样要认。没归属的块跟第一件生效材料走（老格式单块的老行为）。
 */
function buildFeedResolver(session: MixSession, tickets: MixTicketMaterial[], encores: MixEncoreMaterial[]): MixFeedResolver {
    const byId = new Map<string, "latest" | "all" | "none">();
    for (const kind of ["ticket", "encore"] as const) {
        for (const entry of mixSlotEntries(session.recipe.slots, kind)) {
            const mat = getMixMaterial(entry.materialId);
            if (mat?.kind === kind && mat.historyFeed && mat.historyFeed !== "latest") byId.set(mat.id, mat.historyFeed);
        }
    }
    const fallback: Record<"ticket" | "encore", "latest" | "all" | "none"> = {
        ticket: tickets[0]?.historyFeed ?? "latest",
        encore: encores.find((e) => e.contract?.trim())?.historyFeed ?? "latest",
    };
    return (kind, materialId) => (materialId ? byId.get(materialId) ?? "latest" : fallback[kind]);
}

/**
 * 一次生成。给了 onDelta 就走流式：模型吐一段就回调一段，界面能边写边看。
 * 流式只影响"过程怎么看"，落库、拆块、滤网、机括都还是拿到完整正文之后才做——
 * 半个状态栏块、写了一半的标记行都不该被当成结果。
 */
async function runMixGeneration(
    session: MixSession,
    nudge: string | undefined,
    signal?: AbortSignal,
    skipBeforeSend = false,
    onDelta?: (text: string) => void,
): Promise<MixReplyResult> {
    const apiConfig = resolveMixApiConfig();
    if (!apiConfig) {
        throw new ChatEngineError("还没有配置 API 接口，请先到设置里添加。");
    }
    // 落杯前：这里覆盖继续/重说/编辑后重生成三条路径（玩家发言那条在 generateMixReply 里，
    // 因为改写要发生在发言落库之前）；这些路径没有新发言，机括只能追加临时提示
    let working = session;
    let extraNote: string | undefined;
    if (!skipBeforeSend) {
        const before = await runBeforeSendHooks(session);
        working = before.session;
        extraNote = before.note;
        if (working !== session) saveMixSession(working);
    }
    const combinedNudge = [nudge, extraNote].filter(Boolean).join("\n\n") || undefined;
    const { prompt: assembled, tickets, encores, active } = assembleFromSession(working);
    const messages = buildMixMessages(working, assembled, combinedNudge, buildFeedResolver(working, tickets, encores));
    const meta = { characterName: working.charName, userName: working.userName || "你" };
    const llmOptions = { appId: MIX_PROMPT_APP_ID, appTags: MIX_PROMPT_TAGS, skipOutputRegex: true, signal };
    let raw: string;
    if (onDelta) {
        let got = false;
        try {
            const streamed = await sendLLMStreamRequest(apiConfig, null, messages, [], meta, llmOptions, {
                onDelta: (chunk) => { got = true; onDelta(chunk); },
            });
            raw = streamed.content;
        } catch (error) {
            // 一个字都没来就报错：多半是这条接口不支持 SSE（或者中间有代理把它拆了），
            // 退回一次性请求重试一遍；已经吐过字再断的话就是真出错了，照常抛出去
            if (got || (error instanceof Error && signal?.aborted)) throw error;
            raw = await sendLLMRequest(apiConfig, null, messages, [], meta, llmOptions);
        }
    } else {
        raw = await sendLLMRequest(apiConfig, null, messages, [], meta, llmOptions);
    }
    const extracted = extractMixBlocks(raw);
    // 块对号入座：有契约的小票/尾调才是块的候选归属（纯静态小品不收块）
    const contractTickets = tickets.filter((t) => t.contract.trim());
    const contractEncores = encores.filter((e) => e.contract?.trim());
    let ticketBlocks = matchMixBlocks(extracted.tickets, contractTickets);
    let encoreBlocks = matchMixBlocks(extracted.encores, contractEncores);
    // 滤网「进上下文」模式：拆完块后清洗正文再入库，历史发回模型的就是洗过的。
    // 这一格是累加型，条件命中的几张滤网按顺序串联清洗。
    const filterRules = (active.filter ?? [])
        .flatMap((m) => (m.kind === "filter" ? m.rules : []));
    const text = applyMixFilterRules(extracted.text, filterRules.length ? filterRules : undefined, "context");
    if (!text && !ticketBlocks.length) {
        throw new ChatEngineError("模型没有给出内容，请再试一次。");
    }
    // 状态栏补写：逐张核对，漏了哪张就单独把哪张要回来
    if (text) {
        for (const ticket of contractTickets) {
            if (!ticket.renderHtml.trim()) continue;
            if (ticketBlocks.some((b) => b.id === ticket.id)) continue;
            const repaired = await repairMixTicket(apiConfig, working, ticket, text, signal);
            if (repaired) ticketBlocks.push({ id: ticket.id, raw: repaired });
        }
    }
    ticketBlocks = orderMixBlocks(ticketBlocks, contractTickets);
    encoreBlocks = orderMixBlocks(encoreBlocks, contractEncores);
    // 记住的值：用这一轮各张小票自己的块更新，抽不到的保留上一轮；顺带把结果快照在这一轮上，
    // 回溯/重说/编辑时直接取剩下最后一轮的快照还原。
    const stateFromTicket = advanceMixStateWithBlocks(working.state, contractTickets, ticketBlocks);
    // 出杯后：机括能改正文、能写记住的值。放在小票抽值之后——机括是最后一道，
    // 它写的值压得过小票抽出来的
    const afterHook = await runMechanismHooks(
        { ...working, state: stateFromTicket },
        "afterReply",
        {
            text,
            ticketRaws: ticketBlocks.length ? ticketBlocks.map((b) => b.raw) : undefined,
            encoreRaws: encoreBlocks.length ? encoreBlocks.map((b) => b.raw) : undefined,
        },
    );
    const finalText = typeof afterHook.text === "string" ? afterHook.text : text;
    const nextState = mergeHookState(stateFromTicket, afterHook.state);
    const keptTickets = assembled.hasTicket ? ticketBlocks : [];
    const keptEncores = assembled.hasEncore ? encoreBlocks : [];
    const turn: MixTurn = {
        id: createMixId("mixturn"),
        role: "assistant",
        text: finalText,
        // 单块字段冗余存第一块：老读取路径与跨版本数据都还认得
        ticketRaw: keptTickets[0]?.raw,
        encoreRaw: keptEncores[0]?.raw,
        ticketRaws: keptTickets.length ? keptTickets : undefined,
        encoreRaws: keptEncores.length ? keptEncores : undefined,
        state: nextState,
        createdAt: Date.now(),
    };
    const updated: MixSession = {
        ...working,
        turns: [...working.turns, turn],
        state: nextState,
        mechanismStore: afterHook.store,
    };
    saveMixSession(updated);
    return { session: updated, turn };
}

/** 玩家发言 → 生成回复 */
export async function generateMixReply(
    sessionId: string,
    userText: string,
    signal?: AbortSignal,
    onUserTurn?: () => void,
    onDelta?: (text: string) => void,
): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const trimmed = userText.trim();
    if (!trimmed) throw new ChatEngineError("先说点什么吧。");
    // 落杯前钩子放在发言落库之前跑：机括改写的是玩家这一句本身
    //（比如把「/掷骰」换成一段带随机数的指令），落库的就是改写后的版本
    const before = await runBeforeSendHooks(current, trimmed);
    const spoken = (before.text ?? trimmed).trim() || trimmed;
    const userTurn: MixTurn = {
        id: createMixId("mixturn"),
        role: "user",
        text: spoken,
        createdAt: Date.now(),
    };
    const withUser: MixSession = { ...before.session, turns: [...before.session.turns, userTurn] };
    saveMixSession(withUser);
    // 落杯前钩子是 await 的，这句落库比调用方那次「同步回读」晚一拍，
    // 所以得主动喊一声：用户气泡要在模型回来之前就上屏
    onUserTurn?.();
    // 这条路径的落杯前已经跑过了，别在 runMixGeneration 里重复触发
    return runMixGeneration(withUser, before.note, signal, true, onDelta);
}

/** 本局全部小票材料（记住的值的声明来源），按槽位顺序 */
function sessionTickets(session: MixSession): MixTicketMaterial[] {
    return mixSlotEntries(session.recipe.slots, "ticket")
        .map((entry) => getMixMaterial(entry.materialId))
        .filter((m): m is MixTicketMaterial => m?.kind === "ticket");
}

/** 本局全部尾调材料，按槽位顺序 */
function sessionEncores(session: MixSession): MixEncoreMaterial[] {
    return mixSlotEntries(session.recipe.slots, "encore")
        .map((entry) => getMixMaterial(entry.materialId))
        .filter((m): m is MixEncoreMaterial => m?.kind === "encore");
}

/**
 * 截断历史之后把记住的值退回去：取剩下最后一轮的快照，全删光就退回开局初值。
 * 不做这一步的话，回溯三轮重打，好感度还停在被丢掉的那个未来上。
 */
function withRolledBackState(session: MixSession, turns: MixTurn[]): MixSession {
    const initial = initialMixState(sessionTickets(session));
    return { ...session, turns, state: rollbackMixState(turns, initial) };
}

/** 重说：丢弃最后一条 assistant 回复重新生成（开场白除外） */
export async function rerollMixReply(sessionId: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const last = current.turns[current.turns.length - 1];
    if (!last || last.role !== "assistant" || current.turns.length <= 1) {
        throw new ChatEngineError("现在没有可以重说的回复。");
    }
    const trimmedSession = withRolledBackState(current, current.turns.slice(0, -1));
    saveMixSession(trimmedSession);
    const beforeLast = trimmedSession.turns[trimmedSession.turns.length - 1];
    // 上一条也是 assistant（继续产生的），补一个不落库的推进指令避免连续 assistant 消息
    const nudge = beforeLast?.role === "assistant"
        ? "（请接着上文继续推进剧情，换一个写法，不要重复。）"
        : undefined;
    return runMixGeneration(trimmedSession, nudge, signal, false, onDelta);
}

/** 继续：不发言，让角色接着写（推进指令不落库） */
export async function continueMix(sessionId: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    return runMixGeneration(current, "（请接着上文继续推进剧情，直接续写，不要重复已写过的内容。）", signal, false, onDelta);
}

/**
 * 还没开口的对局：进来时用当前角色卡重取开场白。
 *
 * 开场白是建局那一刻写进 turns[0] 的一条消息，不是对材料的引用——所以作者改完卡
 * 回到对局，看到的还是旧的那句。这里只在「这一局玩家一个字都还没说」时重取：
 * 已经聊过的对局绝不动，那是真实历史，改了界面就和发给模型的上下文对不上。
 *
 * 返回是否真的换了，调用方据此决定要不要提示一句。
 */
export function refreshMixOpening(sessionId: string): { session: MixSession; changed: boolean } | null {
    const current = getMixSession(sessionId);
    if (!current) return null;
    const onlyOpening = current.turns.length === 1 && current.turns[0].role === "assistant";
    if (!onlyOpening) return { session: current, changed: false };
    let fresh: string;
    try {
        fresh = assembleFromSession(current).prompt.opening;
    } catch {
        // 卡被删了之类：留着原来那句，别把开场白弄没
        return { session: current, changed: false };
    }
    if (!fresh.trim() || fresh === current.turns[0].text) return { session: current, changed: false };
    const updated: MixSession = {
        ...current,
        turns: [{ ...current.turns[0], text: fresh }],
        updatedAt: Date.now(),
    };
    saveMixSession(updated);
    return { session: updated, changed: true };
}

/** 回溯到某条消息：保留它，删除其后的全部内容 */
export function truncateMixAfterTurn(sessionId: string, turnId: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const idx = current.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) throw new ChatEngineError("消息不存在。");
    const updated = withRolledBackState(current, current.turns.slice(0, idx + 1));
    saveMixSession(updated);
    return updated;
}

/**
 * 编辑某条消息并删除其后的全部内容。
 * assistant 轮编辑的是"原始输出"（含 [状态栏]/[小剧场] 块）——保存时重新剥块解析，
 * 模型输出掉了格式也能手动修好重渲染；玩家发言仍是纯文本。
 * 编辑的是玩家发言时，调用方应随后用 regenerateMixTail 重新生成回复。
 */
export function editMixTurn(sessionId: string, turnId: string, newText: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    const idx = current.turns.findIndex((t) => t.id === turnId);
    if (idx < 0) throw new ChatEngineError("消息不存在。");
    const trimmed = newText.trim();
    if (!trimmed) throw new ChatEngineError("消息不能为空。");
    const kept = current.turns.slice(0, idx);
    let edited: MixTurn;
    if (current.turns[idx].role === "assistant") {
        const parsed = extractMixBlocks(trimmed);
        // 块归属候选：这一轮原本的供稿材料在前（换过装的旧轮编辑后皮不跑偏），
        // 再补当前槽位里的材料（编辑时条件现场已不可考，名字对得上就认）
        const tickets = sessionTickets(current).filter((t) => t.contract.trim());
        const encores = sessionEncores(current).filter((e) => e.contract?.trim());
        const withPrior = (prior: { id?: string }[], mats: { id: string; name: string }[]) => {
            const pool: { id: string; name: string }[] = [];
            for (const block of prior) {
                if (!block.id || pool.some((p) => p.id === block.id)) continue;
                pool.push({ id: block.id, name: getMixMaterial(block.id)?.name ?? "" });
            }
            for (const mat of mats) {
                if (!pool.some((p) => p.id === mat.id)) pool.push(mat);
            }
            return pool;
        };
        const ticketBlocks = matchMixBlocks(parsed.tickets, withPrior(mixTurnTicketBlocks(current.turns[idx]), tickets));
        const encoreBlocks = matchMixBlocks(parsed.encores, withPrior(mixTurnEncoreBlocks(current.turns[idx]), encores));
        // 状态栏被手工改过，这一轮的快照要按新原文重算，否则数字和界面对不上
        const before = withRolledBackState(current, kept).state;
        edited = {
            ...current.turns[idx],
            text: parsed.text,
            ticketRaw: ticketBlocks[0]?.raw,
            encoreRaw: encoreBlocks[0]?.raw,
            ticketRaws: ticketBlocks.length ? ticketBlocks : undefined,
            encoreRaws: encoreBlocks.length ? encoreBlocks : undefined,
            // 换装戳作废：编辑后的块自带归属，旧戳留着会把渲染指错皮
            ticketId: undefined,
            encoreId: undefined,
            state: advanceMixStateWithBlocks(before, tickets, ticketBlocks),
        };
    } else {
        edited = { ...current.turns[idx], text: trimmed };
    }
    const updated = withRolledBackState(current, [...kept, edited]);
    saveMixSession(updated);
    return updated;
}

/** 对当前历史直接生成回复（编辑玩家发言后的重新生成） */
export async function regenerateMixTail(sessionId: string, signal?: AbortSignal, onDelta?: (text: string) => void): Promise<MixReplyResult> {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    return runMixGeneration(current, undefined, signal, false, onDelta);
}

/** 撤回最后一轮：删掉最后一条玩家发言及其后的全部回复 */
export function undoMixLastRound(sessionId: string): MixSession {
    const current = getMixSession(sessionId);
    if (!current) throw new ChatEngineError("对局不存在。");
    let lastUserIdx = -1;
    for (let i = current.turns.length - 1; i >= 0; i -= 1) {
        if (current.turns[i].role === "user") { lastUserIdx = i; break; }
    }
    if (lastUserIdx < 0) throw new ChatEngineError("还没有可以撤回的发言。");
    const updated = withRolledBackState(current, current.turns.slice(0, lastUserIdx));
    saveMixSession(updated);
    return updated;
}
