import { logger } from '../utils/logger';
import { buildClickScript } from './approvalDetector';
import { CdpService } from './cdpService';

/** Info about a detected open-ended question card (Skip/Submit shape) */
export interface AskQuestionInfo {
    /** Dedup key derived from the DOM state at detection time */
    key: string;
    /** Enumerated selectable options scraped from the card, if any (e.g. ["Apple","Orange","Peach"]). Empty for pure free-text questions. */
    options: string[];
}

export interface AskQuestionDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /**
     * Returns true when ApprovalDetector / PlanningDetector / ErrorPopupDetector
     * currently has an active (non-null) detection for this workspace.
     * Used to yield to those detectors so this generic fallback never fights
     * over a dialog that another, more specific detector already recognizes.
     */
    isOtherDetectorActive: () => boolean;
    /** Callback fired when the Skip/Submit question card first appears */
    onQuestionDetected: (info: AskQuestionInfo) => void;
    /** Callback fired when the question card disappears (answered, skipped, or timed out) */
    onResolved?: () => void;
}

/**
 * Detection script for Antigravity's "Asking 1 question" free-text card.
 *
 * Live DOM inspection (2026-07-26) confirmed this shape: a "Skip" button and
 * a "Submit↵" button rendered as siblings inside a small container (no more
 * than ~8 descendants), with NO allow/deny-style approval text nearby. This
 * distinguishes it from:
 *   - ApprovalDetector's radio-list Tier 3 (which also has a Submit button,
 *     but paired with "Yes, allow..." / deny option rows)
 *   - The generic chat send button (which has no visible "Submit↵" text and
 *     no sibling "Skip" button)
 */
const DETECT_ASK_QUESTION_SCRIPT = `(() => {
    const normalize = (text) => (text || '').toLowerCase().replace(/[^\\w\\s,]/g, ' ').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const CLICKABLE_SELECTORS = 'button, [role="button"]';
    // Option-row selectors: same proven set ApprovalDetector uses for the
    // radio-list UI, since Antigravity renders selectable options this way.
    const OPTION_SELECTORS = '[role="option"], [role="listitem"], [role="menuitem"], [role="radio"], li[tabindex], [class*="option"][tabindex], [class*="item"][tabindex], [class*="choice"]';

    const btns = Array.from(document.querySelectorAll(CLICKABLE_SELECTORS)).filter(isVisible);
    const submitBtn = btns.find((b) => normalize(b.textContent || '') === 'submit');
    if (!submitBtn) return null;

    // Walk up from Submit looking for a sibling "Skip" button within a small container.
    let anc = submitBtn.parentElement;
    for (let i = 0; i < 6 && anc && anc !== document.body; i++) {
        const skipBtn = Array.from(anc.querySelectorAll(CLICKABLE_SELECTORS))
            .filter(isVisible)
            .find((b) => normalize(b.textContent || '') === 'skip');
        if (skipBtn) {
            // Reject if this container also has allow/approval-style option rows —
            // that's ApprovalDetector's radio-list Tier 3, not an open question.
            const ALLOW_ONCE_PATTERNS = ['yes, allow this time', 'yes, allow once', 'allow this time', 'allow once', 'allow one time'];
            const hasApprovalOption = Array.from(anc.querySelectorAll('*')).some((el) => {
                if (!isVisible(el) || el.children.length > 8) return false;
                const t = normalize(el.textContent || '');
                return t.length > 0 && t.length <= 180 && ALLOW_ONCE_PATTERNS.some((p) => t.includes(p));
            });
            if (hasApprovalOption) return null;

            // ---- Scrape selectable options (best-effort; MUST NOT break detection) ----
            // Detection drives reply-routing + answer submission, so the whole
            // scrape+dump is wrapped: any throw yields empty options but still
            // returns a valid detection result.
            let options = [];
            let cardDump = '';
            // The Skip/Submit button row (anc) is a TINY wrapper that holds ONLY
            // the two buttons; the question text + selectable options render in a
            // WIDER card root ABOVE it (proven by live cardDump). Climb up from the
            // button row until the subtree text is substantially larger than just
            // 'SkipSubmit' (i.e. it now includes the question/options), capped at a
            // few levels so we never grab the whole panel.
            let scrapeRoot = anc;
            try {
                const btnRowLen = normalize(anc.textContent || '').length;
                let up = anc.parentElement;
                for (let j = 0; j < 5 && up && up !== document.body; j++) {
                    const t = normalize(up.textContent || '');
                    // Stop once the container carries clearly more text than the
                    // bare button row (question + options present).
                    if (t.length > btnRowLen + 12) { scrapeRoot = up; break; }
                    scrapeRoot = up;
                    up = up.parentElement;
                }
            } catch (rootErr) { scrapeRoot = anc; }
            try {
                const cleanText = (el) => ((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim());
                const seen = new Set();
                const pushOpt = (raw) => {
                    let t = (raw || '').replace(/\\s+/g, ' ').trim();
                    if (!t) return;
                    // Strip a leading "1." / "1)" / "1 -" ordinal so labels are clean.
                    t = t.replace(/^\\s*\\d+\\s*[\\.\\)\\-:]\\s*/, '').trim();
                    if (!t || t.length > 200) return;
                    const nt = normalize(t);
                    if (!nt || nt === 'submit' || nt === 'skip') return;
                    if (seen.has(nt)) return;
                    seen.add(nt);
                    options.push(t);
                };

                // 1a) Radiogroup/label rows — Antigravity's ACTUAL multiple-choice
                //     shape: <div role=radiogroup> containing <label><input>...
                //     <span>N</span><span>Label</span></label> rows. Generic
                //     OPTION_SELECTORS miss <label>, and the text fallback fails
                //     because 'N'+'Label' concatenate with no delimiter. Take the
                //     label text, strip a bare leading ordinal, skip the textarea-
                //     only 'Other' row (it has no fixed label to relay).
                const radioLabels = Array.from(scrapeRoot.querySelectorAll('[role=\"radiogroup\"] label, [role=\"radiogroup\"] [role=\"radio\"]'))
                    .filter((el) => isVisible(el));
                for (const el of radioLabels) {
                    if (el.querySelector && el.querySelector('textarea, input[type=\"text\"]')) continue;
                    let t = cleanText(el);
                    // Strip a bare leading ordinal digit (e.g. '1Python' -> 'Python',
                    // '2 JavaScript' -> 'JavaScript') as well as '1.'/'1)' forms.
                    t = t.replace(/^\\s*\\d+\\s*[\\.)\\-:]?\\s*/, '').trim();
                    pushOpt(t);
                }

                // 1b) Generic structured option elements inside the card container.
                if (options.length === 0) {
                    const optEls = Array.from(scrapeRoot.querySelectorAll(OPTION_SELECTORS))
                        .filter((el) => isVisible(el) && el.children.length <= 8);
                    for (const el of optEls) pushOpt(cleanText(el));
                }

                // 2) Fallback: split container text on ordinal markers ("1.", "2)", ...)
                //    so each option ends where the next ordinal begins (not at Skip/Submit).
                if (options.length === 0) {
                    let containerText = cleanText(scrapeRoot);
                    // Cut off the trailing action-button labels if present.
                    containerText = containerText.replace(/(?:\\s*(?:skip|submit)[^a-zA-Z]*)+$/i, '').trim();
                    const ordinal = /\\s*\\d+\\s*[\\.\\)\\-:]\\s+/g;
                    const parts = [];
                    let lastIdx = -1, mm;
                    while ((mm = ordinal.exec(containerText)) !== null) {
                        if (lastIdx >= 0) parts.push(containerText.slice(lastIdx, mm.index));
                        lastIdx = ordinal.lastIndex;
                    }
                    if (lastIdx >= 0) parts.push(containerText.slice(lastIdx));
                    for (const seg of parts) pushOpt(seg);
                }

                // Diagnostic dump: a CLASS/STYLE/SVG-STRIPPED structural
                // skeleton of the card. Raw outerHTML is useless here because a
                // single markdown wrapper carries a ~2KB Tailwind className that
                // eats the whole budget before the option/question structure is
                // reached. This skeleton keeps tag + role/aria + own trimmed text.
                const skel = (el, depth) => {
                    if (!el || depth > 6) return '';
                    const tag = (el.tagName || '').toLowerCase();
                    if (tag === 'svg' || tag === 'path' || tag === 'style' || tag === 'script') return '';
                    const role = el.getAttribute && el.getAttribute('role');
                    const aria = el.getAttribute && el.getAttribute('aria-label');
                    const ti = el.getAttribute && el.getAttribute('tabindex');
                    // own text = direct text nodes only (not descendants)
                    let own = '';
                    for (const n of Array.from(el.childNodes)) {
                        if (n.nodeType === 3) own += n.textContent;
                    }
                    own = own.replace(/\\s+/g, ' ').trim().slice(0, 60);
                    let head = tag;
                    if (role) head += '[role=' + role + ']';
                    if (ti !== null && ti !== undefined) head += '[ti=' + ti + ']';
                    if (aria) head += '[aria=' + aria.slice(0, 30) + ']';
                    if (own) head += ' "' + own + '"';
                    let out = head;
                    const kids = Array.from(el.children).map((c) => skel(c, depth + 1)).filter(Boolean);
                    if (kids.length) out += '{' + kids.join(',') + '}';
                    return out;
                };
                cardDump = skel(scrapeRoot, 0).slice(0, 2500);
            } catch (scrapeErr) {
                options = [];
                cardDump = 'scrape-error: ' + (scrapeErr && scrapeErr.message ? scrapeErr.message : String(scrapeErr));
            }

            return { key: 'ask-question-card', options: options, cardDump: cardDump };
        }
        anc = anc.parentElement;
    }
    return null;
})()`;

/**
 * After no Skip/Submit card is found, the previous state is considered resolved.
 */
const DETECT_ASK_QUESTION_GONE_SCRIPT = DETECT_ASK_QUESTION_SCRIPT;

/**
 * Locate the question card's OWN free-text box — the editable that lives inside
 * the same small container as the Skip/Submit button pair — and focus it.
 *
 * CRITICAL: do NOT just grab the last visible editable in the document. The main
 * chat composer at the bottom of the panel is also a visible editable and is
 * almost always the LAST one in DOM order, so `candidates[last]` targets the
 * composer, not the card. Text then lands in the composer while the card's box
 * stays empty → Submit sends an empty answer (observed live). Anchor to the card
 * container exactly like the detection script does.
 *
 * Also stashes the resolved element on window.__remoatAskBox so the value-set +
 * read-back steps operate on the SAME element without re-querying.
 */
const FOCUS_FREE_TEXT_INPUT_SCRIPT = `(() => {
    const normalize = (text) => (text || '').toLowerCase().replace(/[^\\w\\s,]/g, ' ').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const CLICKABLE_SELECTORS = 'button, [role="button"]';
    const EDITABLE_SELECTORS = 'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]';

    const btns = Array.from(document.querySelectorAll(CLICKABLE_SELECTORS)).filter(isVisible);
    const submitBtn = btns.find((b) => normalize(b.textContent || '') === 'submit');
    if (!submitBtn) return { ok: false, error: 'Submit button not found (card may have closed)' };

    // Walk up from Submit to the small container that also holds a sibling Skip
    // button, then find the editable box INSIDE that container.
    let anc = submitBtn.parentElement;
    for (let i = 0; i < 6 && anc && anc !== document.body; i++) {
        const hasSkip = Array.from(anc.querySelectorAll(CLICKABLE_SELECTORS))
            .filter(isVisible)
            .some((b) => normalize(b.textContent || '') === 'skip');
        if (hasSkip) {
            const editable = Array.from(anc.querySelectorAll(EDITABLE_SELECTORS)).filter(isVisible);
            const box = editable[editable.length - 1];
            if (!box) { anc = anc.parentElement; continue; }
            window.__remoatAskBox = box;
            box.focus();
            return { ok: true, tag: box.tagName, ce: box.getAttribute && box.getAttribute('contenteditable') };
        }
        anc = anc.parentElement;
    }
    return { ok: false, error: 'Card free-text box not found in Skip/Submit container' };
})()`;

/**
 * Set the value of the previously-focused card box (window.__remoatAskBox) and
 * fire the events React needs to register the change, then read the value back.
 *
 * Antigravity's box is a React-controlled input: CDP Input.insertText updates the
 * DOM value but React may not see it unless we use the native value setter +
 * dispatch a bubbling 'input' event (and 'change' for good measure). For
 * contenteditable, set textContent + dispatch input. Returns the box's actual
 * text so the caller can VERIFY the answer landed before clicking Submit.
 */
const buildSetAndReadScript = (value: string) => `(() => {
    const box = window.__remoatAskBox;
    if (!box) return { ok: false, error: 'Card box reference lost' };
    const val = ${JSON.stringify(value)};
    box.focus();
    if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
        const proto = box.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
        if (setter) { setter.call(box, val); } else { box.value = val; }
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, value: box.value };
    }
    // contenteditable / role=textbox
    box.textContent = val;
    box.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
    return { ok: true, value: (box.innerText || box.textContent || '') };
})()`;

/**
 * For a RADIOGROUP multiple-choice card, click the option whose label matches
 * the given text (case/space/punct-insensitive). Antigravity renders these as
 * <div role=radiogroup> containing <label><input type=radio>...<span>N</span>
 * <span>Label</span></label> rows; Submit stays disabled until a radio is
 * selected, so for these cards we must CLICK the row, not type into a box.
 * Prefers 1-based index when provided (exact position), else matches by label.
 * Returns {ok:true, clicked:'<label>'} on success so the caller can verify.
 */
const buildRadioClickScript = (label: string, index: number) => `(() => {
    const normalize = (text) => (text || '').toLowerCase().replace(/[^\\w\\s,]/g, ' ').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const groups = Array.from(document.querySelectorAll('[role=\"radiogroup\"]')).filter(isVisible);
    if (!groups.length) return { ok: false, error: 'no radiogroup' };
    // Use the last visible radiogroup (the active card's), collect its rows.
    const group = groups[groups.length - 1];
    let rows = Array.from(group.querySelectorAll('label, [role=\"radio\"]')).filter(isVisible);
    // Drop rows that are the free-text 'Other' entry (contain a textarea/input).
    const labelRows = rows.filter((el) => !(el.querySelector && el.querySelector('textarea, input[type=\"text\"]')));
    if (!labelRows.length) return { ok: false, error: 'no label rows' };
    const want = normalize(${JSON.stringify(label)});
    const idx = ${index};
    let target = null;
    // 1) Positional index wins for numeric replies (most reliable): the user's
    //    "3" maps to the 3rd option regardless of label-substring ambiguity
    //    (e.g. "java" would loosely match "javascript").
    if (idx >= 1 && idx <= labelRows.length) target = labelRows[idx - 1];
    // 2) Else match by EXACT normalized label (strip any leading ordinal digit).
    //    Exact-only to avoid "java" matching "javascript" or "c" matching others.
    if (!target && want) {
        for (const el of labelRows) {
            let t = normalize((el.innerText || el.textContent || ''));
            t = t.replace(/^\\s*\\d+\\s*/, '').trim();
            if (t && t === want) { target = el; break; }
        }
    }
    if (!target) return { ok: false, error: 'no matching option', rows: labelRows.length };
    // Click the radio input if present, else the row itself.
    const input = target.querySelector && target.querySelector('input[type=\"radio\"], input');
    const clickEl = input || target;
    try { clickEl.click(); } catch (e) { try { target.click(); } catch (e2) {} }
    if (input && !input.checked) { try { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) {} }
    const clickedText = (target.innerText || target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
    return { ok: true, clicked: clickedText };
})()`;

/**
 * Detects Antigravity's "Asking N question(s)" open-ended free-text card
 * (Skip + Submit↵ button pair) via polling.
 *
 * Unlike ApprovalDetector/PlanningDetector, this card's question text is
 * already relayed to Telegram through the normal ResponseMonitor completion
 * flow (it's just the AI's latest response). This detector's job is narrower:
 * flag that the card is currently open so the NEXT Telegram reply from the
 * user gets typed into the card's free-text box and submitted via the
 * "Submit" button, instead of the normal chat-input + Enter path (which may
 * not reliably submit this specific inline card).
 */
export class AskQuestionDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private isOtherDetectorActive: () => boolean;
    private onQuestionDetected: (info: AskQuestionInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** True while the Skip/Submit card was present on the last poll */
    private cardActive: boolean = false;
    /**
     * Execution context where the card was last detected. The Skip/Submit card
     * renders in a webview-frame context (e.g. ctx=1/ctx=2 in DOM_DUMP logs),
     * NOT necessarily the primary/cascade-panel context — so we must scan all
     * contexts and remember which one hit, like ApprovalDetector does.
     * undefined = not yet detected; null = detected in the default context.
     */
    private lastDetectedContextId: number | null | undefined = undefined;

    /** Options scraped from the card at last detection, for numeric-index → label mapping. */
    private lastOptions: string[] = [];

    constructor(options: AskQuestionDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.isOtherDetectorActive = options.isOtherDetectorActive;
        this.onQuestionDetected = options.onQuestionDetected;
        this.onResolved = options.onResolved;
    }

    /** Start monitoring. */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.cardActive = false;
        this.lastDetectedContextId = undefined;
        this.lastOptions = [];
        this.schedulePoll();
    }

    /** Stop monitoring. */
    async stop(): Promise<void> {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** Returns whether monitoring is currently active */
    isActive(): boolean {
        return this.isRunning;
    }

    /** Returns the CDP service instance this detector is bound to */
    getCdpService(): CdpService {
        return this.cdpService;
    }

    /** Returns whether the Skip/Submit question card is currently believed to be open */
    isCardActive(): boolean {
        return this.cardActive;
    }

    private schedulePoll(): void {
        if (!this.isRunning) return;
        this.pollTimer = setTimeout(async () => {
            await this.poll();
            if (this.isRunning) {
                this.schedulePoll();
            }
        }, this.pollIntervalMs);
    }

    private async poll(): Promise<void> {
        try {
            if (this.isOtherDetectorActive()) {
                logger.debug('[AskQuestionDetector] poll skipped: another detector (approval/planning/errorPopup) is active');
                return;
            }

            await this.dumpDiagnostics();

            const detected = await this.detectCard();

            if (detected && !this.cardActive) {
                this.cardActive = true;
                this.lastDetectedContextId = detected.contextId;
                this.lastOptions = detected.options;
                this.onQuestionDetected({ key: detected.key, options: detected.options });
            } else if (!detected && this.cardActive) {
                this.cardActive = false;
                this.lastDetectedContextId = undefined;
                this.lastOptions = [];
                this.onResolved?.();
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('WebSocket disconnected')) {
                return;
            }
            logger.error('[AskQuestionDetector] Error during polling:', error);
        }
    }

    /**
     * Scan all CDP execution contexts for the Skip/Submit question card.
     * The card renders in a webview-frame context (ctx=1/ctx=2 in DOM_DUMP logs),
     * NOT necessarily the primary/cascade-panel context — so mirror
     * ApprovalDetector's full-scan strategy: try the cached context first, then
     * every reported context, then the default context.
     */
    private async detectCard(): Promise<{ key: string; options: string[]; contextId: number | null | undefined } | null> {
        // Fast path: re-use the context where the card was last found
        if (this.lastDetectedContextId !== undefined) {
            const info = await this.evaluateInContext(DETECT_ASK_QUESTION_SCRIPT, this.lastDetectedContextId);
            if (info) return { key: info.key, options: Array.isArray(info.options) ? info.options : [], contextId: this.lastDetectedContextId };
        }

        // Full scan: try every execution context reported by the CDP connection
        const contexts = this.cdpService.getContexts();
        for (const ctx of contexts) {
            if (ctx.id === this.lastDetectedContextId) continue;
            const info = await this.evaluateInContext(DETECT_ASK_QUESTION_SCRIPT, ctx.id);
            if (info) {
                logger.info(`[AskQuestionDetector] SCRIPT HIT ctx ${ctx.id}: ${JSON.stringify(info)}`);
                return { key: info.key, options: Array.isArray(info.options) ? info.options : [], contextId: ctx.id };
            }
        }

        // Final fallback: default context (no contextId param)
        if (this.lastDetectedContextId !== null) {
            const info = await this.evaluateInContext(DETECT_ASK_QUESTION_SCRIPT, null);
            if (info) {
                logger.info(`[AskQuestionDetector] SCRIPT HIT ctx default: ${JSON.stringify(info)}`);
                return { key: info.key, options: Array.isArray(info.options) ? info.options : [], contextId: null };
            }
        }

        return null;
    }

    /**
     * Type the given answer into the question card's free-text box and click Submit.
     * Falls back to Enter if no Submit button is found (card may have already closed).
     * Uses the context where the card was last detected so the text lands in the
     * correct webview frame.
     */
    async submitAnswer(text: string): Promise<{ ok: boolean; error?: string }> {
        const contextId = this.lastDetectedContextId;
        if (contextId === undefined) {
            return { ok: false, error: 'Ask-question card context not known (card may have closed)' };
        }

        // If the user replied with a bare option number (e.g. "1") and we scraped
        // options at detection, inject the option's LABEL instead of the digit.
        // Antigravity interprets a bare digit inconsistently (observed "1" selecting
        // the wrong option), whereas the exact label text lands reliably as free text.
        let answer = text;
        const trimmed = text.trim();
        if (/^\d+$/.test(trimmed) && this.lastOptions.length > 0) {
            const idx = parseInt(trimmed, 10) - 1; // options are presented 1-based
            if (idx >= 0 && idx < this.lastOptions.length) {
                answer = this.lastOptions[idx];
                logger.info(`[AskQuestionDetector] Mapped numeric reply "${trimmed}" -> option "${answer}"`);
            } else {
                logger.info(`[AskQuestionDetector] Numeric reply "${trimmed}" out of range (1..${this.lastOptions.length}); sending as-is`);
            }
        }

        // RADIOGROUP path first: if this is a multiple-choice card, clicking the
        // matching option is the ONLY way to submit (Submit stays disabled until a
        // radio is selected; there is no free-text box to type into). Map the
        // 1-based reply index when the user replied with a bare number.
        const radioIdx = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : -1;
        const radioRes = await this.evaluateInContext(buildRadioClickScript(answer, radioIdx), contextId);
        if (radioRes?.ok === true) {
            logger.info(`[AskQuestionDetector] radio option clicked ctx ${contextId}: ${JSON.stringify(radioRes)}`);
            await new Promise((resolve) => setTimeout(resolve, 150));
            const submitClickedR = await this.evaluateInContext(buildClickScript('Submit'), contextId);
            if (submitClickedR?.ok !== true) {
                await this.pressEnter();
            }
            this.cardActive = false;
            this.lastDetectedContextId = undefined;
            return { ok: true };
        }
        logger.info(`[AskQuestionDetector] no radiogroup match (${JSON.stringify(radioRes)}); trying free-text path`);

        const focused = await this.evaluateInContext(FOCUS_FREE_TEXT_INPUT_SCRIPT, contextId);
        if (focused?.ok !== true) {
            return { ok: false, error: focused?.error || 'Failed to focus free-text input' };
        }
        logger.info(`[AskQuestionDetector] focused card box ctx ${contextId}: ${JSON.stringify(focused)}`);

        // Primary path: set the value via the native setter + input/change events so
        // React registers it, then read the box's value back to VERIFY it landed.
        const setRes = await this.evaluateInContext(buildSetAndReadScript(answer), contextId);
        let landed = setRes?.ok === true && typeof setRes.value === 'string' && setRes.value.length > 0;
        logger.info(`[AskQuestionDetector] set-and-read result: ${JSON.stringify(setRes)} (landed=${landed})`);

        // Fallback: if the JS setter didn't take, try the CDP keystroke path into
        // the (still-focused) box, then re-read to confirm.
        if (!landed) {
            await this.cdpService.call('Input.insertText', { text: answer });
            await new Promise((resolve) => setTimeout(resolve, 150));
            const readRes = await this.evaluateInContext(
                `(() => { const b = window.__remoatAskBox; if (!b) return { ok:false }; return { ok:true, value: (b.value !== undefined ? b.value : (b.innerText || b.textContent || '')) }; })()`,
                contextId,
            );
            landed = readRes?.ok === true && typeof readRes.value === 'string' && readRes.value.length > 0;
            logger.info(`[AskQuestionDetector] insertText fallback read: ${JSON.stringify(readRes)} (landed=${landed})`);
        }

        // Do NOT click Submit on an empty box — that's exactly the empty-answer bug.
        if (!landed) {
            return { ok: false, error: 'Answer text did not land in the card free-text box (box empty after injection)' };
        }

        await new Promise((resolve) => setTimeout(resolve, 100));

        const submitClicked = await this.evaluateInContext(buildClickScript('Submit'), contextId);
        if (submitClicked?.ok !== true) {
            await this.pressEnter();
        }

        this.cardActive = false;
        this.lastDetectedContextId = undefined;
        return { ok: true };
    }

    private async pressEnter(): Promise<void> {
        await this.cdpService.call('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
        });
        await this.cdpService.call('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: 'Enter',
            code: 'Enter',
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
        });
    }

    /**
     * Emit a per-context diagnostic of what the detector sees each poll, so we
     * can tell WHY detection returns null (no submit btn? no skip sibling?
     * approval-gate tripped?) and inspect the real card HTML. debug-level only.
     */
    private async dumpDiagnostics(): Promise<void> {
        const DIAG_SCRIPT = `(() => {
            const normalize = (text) => (text || '').toLowerCase().replace(/[^\\w\\s,]/g, ' ').replace(/\\s+/g, ' ').trim();
            const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
            const btns = Array.from(document.querySelectorAll('button, [role=\"button\"]')).filter(isVisible);
            const btnLabels = btns.map((b) => normalize(b.textContent || b.getAttribute('aria-label') || '')).filter((t) => t);
            // Exact + substring-tolerant, in case this build labels the action
            // button differently (no trailing glyph, 'Send', a div, etc.).
            const submitBtn = btns.find((b) => normalize(b.textContent || '') === 'submit')
                || btns.find((b) => { const t = normalize(b.textContent || b.getAttribute('aria-label') || ''); return t === 'submit' || t.indexOf('submit') >= 0 || t === 'send' || t.indexOf('send answer') >= 0; });
            // Any element whose text is exactly/contains 'skip' — the card's tell.
            const skipEls = Array.from(document.querySelectorAll('button, [role=\"button\"], a, div, span'))
                .filter(isVisible)
                .filter((el) => { const t = normalize(el.textContent || ''); return (t === 'skip' || t.indexOf('skip') >= 0) && t.length <= 40 && el.children.length <= 3; })
                .slice(0, 4)
                .map((el) => ({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 40), cls: (el.className || '').toString().slice(0, 60) }));
            let skipFound = false, approvalGate = false, cardHtml = '';
            if (submitBtn) {
                let anc = submitBtn.parentElement;
                for (let i = 0; i < 6 && anc && anc !== document.body; i++) {
                    const skipBtn = Array.from(anc.querySelectorAll('button, [role=\"button\"], a, div, span')).filter(isVisible).find((b) => { const t = normalize(b.textContent || ''); return (t === 'skip' || t.indexOf('skip') >= 0) && t.length <= 40; });
                    if (skipBtn) {
                        skipFound = true;
                        const ALLOW = ['yes, allow this time', 'yes, allow once', 'allow this time', 'allow once', 'allow one time'];
                        approvalGate = Array.from(anc.querySelectorAll('*')).some((el) => { if (!isVisible(el) || el.children.length > 8) return false; const t = normalize(el.textContent || ''); return t.length > 0 && t.length <= 180 && ALLOW.some((p) => t.includes(p)); });
                        try { cardHtml = (anc.outerHTML || '').slice(0, 1500); } catch (e) { cardHtml = 'n/a'; }
                        break;
                    }
                    anc = anc.parentElement;
                }
            }
            // If a skip element exists but no submit matched, still dump the skip's
            // container so we can see how THIS build names the action button.
            if (!cardHtml && skipEls.length) {
                try {
                    const ske = Array.from(document.querySelectorAll('button, [role=\"button\"], a, div, span')).filter(isVisible).find((el) => { const t = normalize(el.textContent || ''); return (t === 'skip' || t.indexOf('skip') >= 0) && t.length <= 40 && el.children.length <= 3; });
                    let a = ske && ske.parentElement;
                    for (let i = 0; i < 4 && a && a !== document.body; i++) a = a.parentElement;
                    if (a) cardHtml = (a.outerHTML || '').slice(0, 1500);
                } catch (e) { cardHtml = 'skip-dump-error'; }
            }
            // Presence probe: is the card's text even reachable in THIS context?
            // Distinguishes 'wrong button label' from 'card lives in an
            // un-enumerated frame/context' (bodyText has no skip/submit at all).
            const bodyText = normalize((document.body && (document.body.innerText || document.body.textContent)) || '');
            const txt = { hasSkipTxt: bodyText.indexOf('skip') >= 0, hasSubmitTxt: bodyText.indexOf('submit') >= 0, iframes: document.querySelectorAll('iframe, webview').length };
            // ---- FULL one-shot structural skeleton of the whole card region ----
            // Class/style/svg-stripped so an entire panel fits in the budget. This
            // captures question text + ANY option rows + the button row together,
            // so a single capture is decisive (no back-and-forth). Best-effort.
            let fullSkeleton = '';
            try {
                const skel = (el, depth) => {
                    if (!el || depth > 8) return '';
                    const tag = (el.tagName || '').toLowerCase();
                    if (tag === 'svg' || tag === 'path' || tag === 'style' || tag === 'script') return '';
                    if (!isVisible(el)) return '';
                    const role = el.getAttribute && el.getAttribute('role');
                    const aria = el.getAttribute && el.getAttribute('aria-label');
                    const ti = el.getAttribute && el.getAttribute('tabindex');
                    let own = '';
                    for (const n of Array.from(el.childNodes)) { if (n.nodeType === 3) own += n.textContent; }
                    own = own.replace(/\\s+/g, ' ').trim().slice(0, 80);
                    let head = tag;
                    if (role) head += '[role=' + role + ']';
                    if (ti !== null && ti !== undefined) head += '[ti=' + ti + ']';
                    if (aria) head += '[aria=' + aria.slice(0, 40) + ']';
                    if (own) head += ' "' + own + '"';
                    let out = head;
                    const kids = Array.from(el.children).map((c) => skel(c, depth + 1)).filter(Boolean);
                    if (kids.length) out += '{' + kids.join(',') + '}';
                    return out;
                };
                // Anchor to the Skip/Submit element and climb ~12 levels to reach
                // the whole agent conversation panel (well above the tiny button row).
                let fullRoot = submitBtn || (Array.from(document.querySelectorAll('button, [role=\"button\"], a, div, span')).filter(isVisible).find((el) => { const t = normalize(el.textContent || ''); return (t === 'skip' || t.indexOf('skip') >= 0) && t.length <= 40 && el.children.length <= 3; }));
                if (fullRoot) {
                    let up = fullRoot;
                    for (let k = 0; k < 12 && up.parentElement && up.parentElement !== document.body; k++) up = up.parentElement;
                    fullRoot = up;
                }
                fullSkeleton = fullRoot ? skel(fullRoot, 0).slice(0, 15000) : '';
            } catch (e) { fullSkeleton = 'skeleton-error: ' + (e && e.message ? e.message : String(e)); }
            return { url: location.href.slice(0, 80), btnLabels: btnLabels, hasSubmit: !!submitBtn, skipFound: skipFound, skipEls: skipEls, approvalGate: approvalGate, cardHtml: cardHtml, txt: txt, fullSkeleton: fullSkeleton };
        })()`;

        const contexts = this.cdpService.getContexts();
        const ids: Array<number | null> = contexts.map((c) => c.id);
        ids.push(null);
        for (const ctxId of ids) {
            try {
                const v = await this.evaluateInContext(DIAG_SCRIPT, ctxId);
                if (v && (v.hasSubmit || (v.skipEls && v.skipEls.length) || (v.txt && (v.txt.hasSkipTxt || v.txt.hasSubmitTxt)) || (v.btnLabels && v.btnLabels.length))) {
                    logger.debug(`[AskQuestionDetector] DIAG ctx=${ctxId ?? 'default'} url=${v.url} hasSubmit=${v.hasSubmit} skipFound=${v.skipFound} txt=${JSON.stringify(v.txt)} skipEls=${JSON.stringify(v.skipEls)} approvalGate=${v.approvalGate} btns=${JSON.stringify(v.btnLabels)} cardHtml=${JSON.stringify(v.cardHtml)} SKELETON=${JSON.stringify(v.fullSkeleton)}`);
                }
            } catch (e) {
                logger.debug(`[AskQuestionDetector] DIAG ctx=${ctxId ?? 'default'} eval error: ${(e as Error)?.message?.slice(0, 80)}`);
            }
        }
    }

    /**
     * Execute Runtime.evaluate in a specific context and return result.value.
     * contextId undefined/null → evaluate in the default context (no contextId param).
     */
    private async evaluateInContext(expression: string, contextId: number | null | undefined): Promise<any> {
        const callParams: Record<string, unknown> = {
            expression,
            returnByValue: true,
            awaitPromise: false,
        };
        if (contextId !== null && contextId !== undefined) {
            callParams.contextId = contextId;
        }
        const result = await this.cdpService.call('Runtime.evaluate', callParams);
        if (result?.result?.subtype === 'error') {
            return null;
        }
        return result?.result?.value;
    }
}

// Re-export for callers that only need the "gone" detection expression name for clarity.
export { DETECT_ASK_QUESTION_GONE_SCRIPT };
