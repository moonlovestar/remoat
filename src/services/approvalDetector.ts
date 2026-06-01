import { logger } from '../utils/logger';
import { CdpService } from './cdpService';

/** Approval button information */
export interface ApprovalInfo {
    /** Allow button text (e.g. "Allow") */
    approveText: string;
    /** Per-conversation allow button text (e.g. "Allow This Conversation") */
    alwaysAllowText?: string;
    /** Deny button text (e.g. "Deny") */
    denyText: string;
    /** Action description (e.g. "write to file.ts") */
    description: string;
    /** True when the UI requires selecting an option then clicking Submit (radio-list style) */
    submitRequired?: boolean;
}

export interface ApprovalDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 1500ms) */
    pollIntervalMs?: number;
    /** Callback when an approval button is detected */
    onApprovalRequired: (info: ApprovalInfo) => void;
    /** Callback when a previously detected approval is resolved (buttons disappeared) */
    onResolved?: () => void;
}

/**
 * Approval button detection script for the Antigravity UI
 *
 * Detects allow/deny button pairs and extracts descriptions with fallbacks.
 */
export const DETECT_APPROVAL_SCRIPT = `(() => {
    const ALLOW_ONCE_PATTERNS = [
        'yes, allow this time', 'yes, allow once', 'allow this time',
        'allow once', 'allow one time',
        '今回のみ許可', '1回のみ許可', '一度許可', '同意授權',
    ];
    const ALWAYS_ALLOW_PATTERNS = [
        'yes, and always allow', 'yes, always allow',
        'allow this conversation', 'allow this chat', 'always allow',
        '常に許可', 'この会話を許可',
    ];
    const ALLOW_PATTERNS = ['yes, allow', 'allow', 'permit', 'run', 'execute', '許可', '承認', '確認', '実行', '同意授權'];
    const DENY_PATTERNS = [
        "don't run", "don't allow", "don't",
        'no (', 'no,', 'no.', 'no!',
        'deny', 'reject', '拒否', 'decline', '却下', 'skip',
        'cancel', 'not now', 'dismiss', 'close', 'abort',
        'いいえ', 'キャンセル', '拒絕授權', 'other (write your answer)',
    ];

    const normalize = (text) => (text || '').toLowerCase().replace(/[^\\w\\s,]/g, ' ').replace(/\\s+/g, ' ').trim();
    // offsetParent is null for position:fixed elements in Chrome — use getBoundingClientRect as fallback
    const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);

    const CLICKABLE_SELECTORS = [
        'button', '[role="button"]',
        '[role="option"]', '[role="listitem"]', '[role="menuitem"]',
        'li[tabindex]', '[class*="option"][tabindex]', '[class*="item"][tabindex]',
    ];

    function findApprovalInContainer(container) {
        const items = Array.from(container.querySelectorAll(CLICKABLE_SELECTORS.join(','))).filter(isVisible);
        let approveBtn = items.find(el => ALLOW_ONCE_PATTERNS.some(p => normalize(el.textContent || '').includes(p))) || null;
        if (!approveBtn) {
            approveBtn = items.find(el => {
                const t = normalize(el.textContent || '');
                return !ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p)) && ALLOW_PATTERNS.some(p => t.includes(p));
            }) || null;
        }
        if (!approveBtn) return null;
        const denyBtn = items.find(el => DENY_PATTERNS.some(p => normalize(el.textContent || '').includes(p))) || null;
        const alwaysAllowBtn = items.find(el => ALWAYS_ALLOW_PATTERNS.some(p => normalize(el.textContent || '').includes(p))) || null;
        return { approveBtn, denyBtn, alwaysAllowBtn };
    }

    function extractDescription(container, approveBtn) {
        const titleEl = container.querySelector('h1, h2, h3, [role="heading"], [class*="title"], [class*="heading"], [class*="label"]');
        const bodyEl = container.querySelector('p, .description, [data-testid="description"], [class*="body"], [class*="detail"], [class*="subtitle"], code');
        if (titleEl) {
            let desc = (titleEl.textContent || '').trim();
            if (bodyEl) { const d = (bodyEl.textContent || '').trim(); if (d && d !== desc) desc += ' — ' + d; }
            if (desc) return desc;
        }
        const parent = approveBtn.parentElement?.parentElement || approveBtn.parentElement;
        if (parent) {
            const clone = parent.cloneNode(true);
            clone.querySelectorAll(CLICKABLE_SELECTORS.join(',')).forEach(b => b.remove());
            const t = (clone.textContent || '').trim();
            if (t.length > 5 && t.length < 500) return t;
        }
        return container.getAttribute('aria-label') || approveBtn.getAttribute('aria-label') || '';
    }

    function makeResult(container, found) {
        const { approveBtn, denyBtn, alwaysAllowBtn } = found;
        return {
            approveText: (approveBtn.textContent || '').trim(),
            alwaysAllowText: alwaysAllowBtn ? (alwaysAllowBtn.textContent || '').trim() : '',
            denyText: denyBtn ? (denyBtn.textContent || '').trim() : '',
            description: extractDescription(container, approveBtn),
        };
    }

    function findRadioListApproval() {
        // Antigravity's URL permission prompt can render as a selected-option list:
        //   "Yes, allow this time" / "Yes, and always allow" / "No (...)" + Submit
        // The option rows may be plain div/span elements, not buttons or role=option,
        // so the normal clickable-selector scan misses them.
        const candidateEls = Array.from(document.querySelectorAll('*')).filter(el => {
            if (!isVisible(el)) return false;
            if (el.children.length > 8) return false;
            const t = normalize(el.textContent || '');
            if (t.length === 0 || t.length > 180) return false;
            return ALLOW_ONCE_PATTERNS.some(p => t.includes(p));
        }).sort((a, b) => {
            const ta = normalize(a.textContent || '');
            const tb = normalize(b.textContent || '');
            const aExact = ALLOW_ONCE_PATTERNS.some(p => ta === p);
            const bExact = ALLOW_ONCE_PATTERNS.some(p => tb === p);
            if (aExact !== bExact) return aExact ? -1 : 1;
            if (a.children.length !== b.children.length) return a.children.length - b.children.length;
            return ta.length - tb.length;
        });

        for (const approveEl of candidateEls) {
            let anc = approveEl.parentElement;
            for (let i = 0; i < 12 && anc && anc !== document.body; i++) {
                const submitBtn = Array.from(anc.querySelectorAll('button, [role="button"]'))
                    .filter(isVisible)
                    .find(b => normalize(b.textContent || b.getAttribute('aria-label') || '') === 'submit');
                if (!submitBtn) {
                    anc = anc.parentElement;
                    continue;
                }

                const elems = Array.from(anc.querySelectorAll('*'))
                    .filter(el => isVisible(el) && el.children.length <= 8 && (el.textContent || '').length <= 180);
                const denyEl = elems.find(el => DENY_PATTERNS.some(p => normalize(el.textContent || '').includes(p))) || null;
                const alwaysEl = elems.find(el => ALWAYS_ALLOW_PATTERNS.some(p => normalize(el.textContent || '').includes(p))) || null;
                const titleEl = anc.querySelector('h1,h2,h3,[role="heading"],[class*="title"],[class*="heading"],[class*="label"]');
                const bodyEl = anc.querySelector('p,.description,[data-testid="description"],[class*="body"],[class*="detail"],[class*="subtitle"],code');
                let description = titleEl ? (titleEl.textContent || '').trim() : '';
                if (bodyEl) {
                    const body = (bodyEl.textContent || '').trim();
                    if (body && body !== description) description = description ? description + ' — ' + body : body;
                }

                return {
                    approveText: (approveEl.textContent || '').trim(),
                    alwaysAllowText: alwaysEl ? (alwaysEl.textContent || '').trim() : '',
                    denyText: denyEl ? (denyEl.textContent || '').trim() : '',
                    description,
                    submitRequired: true,
                };
            }
        }
        return null;
    }

    // ---- TIER 1: .notify-user-container (Antigravity's inline agent panel prompts) ----
    const notifyContainers = Array.from(document.querySelectorAll('.notify-user-container')).filter(isVisible);
    for (let i = notifyContainers.length - 1; i >= 0; i--) {
        const found = findApprovalInContainer(notifyContainers[i]);
        if (found) return makeResult(notifyContainers[i], found);
    }

    // ---- TIER 2: modal/dialog containers ----
    const dialogContainers = Array.from(document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], .modal, .dialog, .approval-container, .permission-dialog, [class*="permission"], [class*="approval"]'
    )).filter(isVisible);
    for (let i = dialogContainers.length - 1; i >= 0; i--) {
        const found = findApprovalInContainer(dialogContainers[i]);
        if (found) return makeResult(dialogContainers[i], found);
    }

    // ---- TIER 3: radio-list option UI with a Submit button ----
    const radioListApproval = findRadioListApproval();
    if (radioListApproval) return radioListApproval;

    // ---- TIER 4: global scan — REQUIRES deny button to avoid VS Code false positives ----
    const allInteractive = Array.from(document.querySelectorAll(CLICKABLE_SELECTORS.join(','))).filter(isVisible);
    let approveBtn = allInteractive.find(el => ALLOW_ONCE_PATTERNS.some(p => normalize(el.textContent || '').includes(p))) || null;
    if (!approveBtn) {
        approveBtn = allInteractive.find(el => {
            const t = normalize(el.textContent || '');
            return !ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p)) && ALLOW_PATTERNS.some(p => t.includes(p));
        }) || null;
    }
    if (!approveBtn) return null;

    let container = approveBtn.closest('[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, [class*="permission"], [class*="approval"]');
    if (!container) {
        let el = approveBtn.parentElement;
        for (let i = 0; i < 8 && el && el !== document.body; i++) {
            if (Array.from(el.querySelectorAll(CLICKABLE_SELECTORS.join(','))).filter(isVisible)
                    .some(b => DENY_PATTERNS.some(p => normalize(b.textContent || '').includes(p)))) {
                container = el; break;
            }
            el = el.parentElement;
        }
    }
    if (!container) return null;

    const containerItems = Array.from(container.querySelectorAll(CLICKABLE_SELECTORS.join(','))).filter(isVisible);
    const denyBtn = containerItems.find(el => DENY_PATTERNS.some(p => normalize(el.textContent || '').includes(p))) || null;
    if (!denyBtn) return null;
    const alwaysAllowBtn = containerItems.find(el => ALWAYS_ALLOW_PATTERNS.some(p => normalize(el.textContent || '').includes(p))) || null;
    return makeResult(container, { approveBtn, denyBtn, alwaysAllowBtn });

})()`;

/**
 * Press the toggle on the right side of Allow Once to expand the Always Allow dropdown.
 */
const EXPAND_ALWAYS_ALLOW_MENU_SCRIPT = `(() => {
    const ALLOW_ONCE_PATTERNS = [
        'yes, allow this time',
        'yes, allow once',
        'allow this time',
        'allow once',
        'allow one time',
        '今回のみ許可',
        '1回のみ許可',
        '一度許可',
        '同意授權',
    ];
    const ALWAYS_ALLOW_PATTERNS = [
        'yes, and always allow',
        'yes, always allow',
        'allow this conversation',
        'allow this chat',
        'always allow',
        '常に許可',
        'この会話を許可',
    ];

    const CLICKABLE_SELECTORS = [
        'button', '[role="button"]',
        '[role="option"]',
        '[role="listitem"]',
        '[role="menuitem"]',
        'li[tabindex]',
        '[class*="option"][tabindex]',
        '[class*="item"][tabindex]',
    ];

    const normalize = (text) => (text || '').toLowerCase().replace(/[^\\w\\s,]/g, ' ').replace(/\\s+/g, ' ').trim();
    const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
    const visibleItems = Array.from(document.querySelectorAll(CLICKABLE_SELECTORS.join(',')))
        .filter(isVisible);

    const directAlways = visibleItems.find(el => {
        const t = normalize(el.textContent || '');
        return ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
    });
    if (directAlways) return { ok: true, reason: 'already-visible' };

    const allowOnceBtn = visibleItems.find(el => {
        const t = normalize(el.textContent || '');
        return ALLOW_ONCE_PATTERNS.some(p => t.includes(p));
    });
    if (!allowOnceBtn) return { ok: false, error: 'allow-once button not found' };

    const container = allowOnceBtn.closest(
        '[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, [class*="permission"], [class*="approval"]'
    )
        || allowOnceBtn.parentElement?.parentElement
        || allowOnceBtn.parentElement
        || document.body;

    const containerButtons = Array.from(container.querySelectorAll('button'))
        .filter(isVisible);

    const toggleBtn = containerButtons.find(btn => {
        if (btn === allowOnceBtn) return false;
        const text = normalize(btn.textContent || '');
        const aria = normalize(btn.getAttribute('aria-label') || '');
        const hasPopup = btn.getAttribute('aria-haspopup');
        if (hasPopup === 'menu' || hasPopup === 'listbox') return true;
        if (text === '') return true;
        return /menu|more|expand|options|dropdown|chevron|arrow/.test(aria);
    });

    if (toggleBtn) {
        toggleBtn.click();
        return { ok: true, reason: 'toggle-button' };
    }

    const rect = allowOnceBtn.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
        return { ok: false, error: 'allow-once button rect unavailable' };
    }

    const clickX = rect.right - Math.max(4, Math.min(12, rect.width * 0.15));
    const clickY = rect.top + rect.height / 2;

    const events = ['pointerdown', 'mousedown', 'mouseup', 'click'];
    for (const type of events) {
        allowOnceBtn.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: clickX,
            clientY: clickY,
        }));
    }
    return { ok: true, reason: 'allow-once-right-edge' };
})()`;

/**
 * Generate a CDP script that clicks a button
 *
 * @param buttonText Text of the button to click
 */
export function buildClickScript(buttonText: string): string {
    const safeText = JSON.stringify(buttonText);
    return `(() => {
        const normalize = (text) => (text || '').toLowerCase().replace(/[^\\w\\s,]/g, ' ').replace(/\\s+/g, ' ').trim();
        const text = ${safeText};
        const wanted = normalize(text);
        const isVisible = (el) => el.offsetParent !== null || (el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0);
        // Phase 1: standard interactive selectors
        const CLICKABLE_SELECTORS = [
            'button', '[role="button"]',
            '[role="option"]', '[role="listitem"]', '[role="menuitem"]',
            'li[tabindex]', '[class*="option"][tabindex]', '[class*="item"][tabindex]',
        ];
        let target = Array.from(document.querySelectorAll(CLICKABLE_SELECTORS.join(','))).find(el => {
            if (!isVisible(el)) return false;
            const t = normalize(el.textContent || '');
            const a = normalize(el.getAttribute('aria-label') || '');
            return t === wanted || a === wanted || t.includes(wanted) || a.includes(wanted);
        }) || null;
        // Phase 2: fallback — search ALL visible leaf-ish elements (handles option-list divs/spans).
        // Prefer exact, leaf-like matches so we do not click the whole permission card.
        if (!target) {
            const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
                if (!isVisible(el)) return false;
                if (el.children.length > 8) return false;
                const t = normalize(el.textContent || '');
                if (t.length > 200) return false;
                return t === wanted || t.includes(wanted);
            }).sort((a, b) => {
                const ta = normalize(a.textContent || '');
                const tb = normalize(b.textContent || '');
                const aExact = ta === wanted;
                const bExact = tb === wanted;
                if (aExact !== bExact) return aExact ? -1 : 1;
                if (a.children.length !== b.children.length) return a.children.length - b.children.length;
                return ta.length - tb.length;
            });
            target = candidates[0] || null;
        }
        if (!target) return { ok: false, error: 'Element not found: ' + text };
        const rect = target.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
            target.dispatchEvent(new MouseEvent(type, {
                bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy
            }));
        }
        return { ok: true };
    })()`;
}

/**
 * Class that detects approval buttons in the Antigravity UI via polling.
 *
 * Notifies detected button info through the onApprovalRequired callback,
 * and performs the actual click operations via approveButton() / denyButton() methods.
 */
export class ApprovalDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onApprovalRequired: (info: ApprovalInfo) => void;
    private onResolved?: () => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    private pollCount: number = 0;
    /** Key of the last detected button info (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full ApprovalInfo from the last detection (used for clicking) */
    private lastDetectedInfo: ApprovalInfo | null = null;
    /** Execution context ID where buttons were last found (undefined = not yet discovered) */
    private lastDetectedContextId: number | null | undefined = undefined;

    constructor(options: ApprovalDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 1500;
        this.onApprovalRequired = options.onApprovalRequired;
        this.onResolved = options.onResolved;
    }

    /**
     * Start monitoring.
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.lastDetectedContextId = undefined;
        this.schedulePoll();
    }

    /**
     * Stop monitoring.
     */
    async stop(): Promise<void> {
        this.isRunning = false;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
        this.lastDetectedContextId = undefined;
    }

    /**
     * Return the last detected approval button info.
     * Returns null if nothing has been detected.
     */
    getLastDetectedInfo(): ApprovalInfo | null {
        return this.lastDetectedInfo;
    }

    /** Schedule the next poll */
    private schedulePoll(): void {
        if (!this.isRunning) return;
        this.pollTimer = setTimeout(async () => {
            await this.poll();
            if (this.isRunning) {
                this.schedulePoll();
            }
        }, this.pollIntervalMs);
    }

    /**
     * Single poll iteration:
     *   1. Scan all execution contexts for approval buttons
     *   2. Notify via callback only on new detection (prevent duplicates)
     *   3. Reset state when buttons disappear
     */
    private async poll(): Promise<void> {
        try {
            this.pollCount++;
            const detected = await this.detectApproval();
            const info = detected?.info ?? null;

            if (info) {
                const key = `${info.approveText}::${info.description}`;
                if (key !== this.lastDetectedKey) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    this.lastDetectedContextId = detected!.contextId;
                    Promise.resolve(this.onApprovalRequired(info)).catch((err) => {
                        logger.error('[ApprovalDetector] onApprovalRequired callback failed:', err);
                    });
                }
            } else {
                // Log every 5th miss so we can confirm the detector is alive
                if (this.pollCount % 5 === 0) {
                    logger.info(`[ApprovalDetector] poll #${this.pollCount} — no approval dialog found`);
                }
                const wasDetected = this.lastDetectedKey !== null;
                this.lastDetectedKey = null;
                this.lastDetectedInfo = null;
                this.lastDetectedContextId = undefined;
                if (wasDetected && this.onResolved) {
                    this.onResolved();
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('WebSocket disconnected')) {
                return;
            }
            logger.error('[ApprovalDetector] Error during polling:', error);
        }
    }

    /**
     * Scan all CDP execution contexts for the permission dialog.
     * Tries the cached context first (fast path), then falls back to a full scan.
     */
    private async detectApproval(): Promise<{ info: ApprovalInfo; contextId: number | null | undefined } | null> {
        // Fast path: re-use the context where buttons were last found
        if (this.lastDetectedContextId !== undefined) {
            const info = await this.evaluateDetectScript(this.lastDetectedContextId);
            if (info) return { info, contextId: this.lastDetectedContextId };
        }

        // Full scan: try every execution context reported by the CDP connection
        const contexts = this.cdpService.getContexts();
        for (const ctx of contexts) {
            if (ctx.id === this.lastDetectedContextId) continue;
            const info = await this.evaluateDetectScript(ctx.id);
            if (info) return { info, contextId: ctx.id };
        }

        // Final fallback: default context (no contextId param)
        if (this.lastDetectedContextId !== null) {
            const info = await this.evaluateDetectScript(null);
            if (info) return { info, contextId: null };
        }

        return null;
    }

    /** Run DETECT_APPROVAL_SCRIPT in the given context; returns null on any error or miss. */
    private async evaluateDetectScript(contextId: number | null | undefined): Promise<ApprovalInfo | null> {
        try {
            const callParams: Record<string, unknown> = {
                expression: DETECT_APPROVAL_SCRIPT,
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null && contextId !== undefined) {
                callParams.contextId = contextId;
            }
            const result = await this.cdpService.call('Runtime.evaluate', callParams);
            if (result?.result?.subtype === 'error') {
                logger.info(`[ApprovalDetector] Script error in ctx ${contextId}: ${result.result.description}`);
                return null;
            }
            const value = result?.result?.value ?? null;
            if (value) {
                logger.info(`[ApprovalDetector] SCRIPT HIT ctx ${contextId}: ${JSON.stringify(value)}`);
            }
            return value;
        } catch (e) {
            logger.info(`[ApprovalDetector] Eval exception ctx ${contextId}: ${(e as Error)?.message?.slice(0, 120)}`);
            return null;
        }
    }

    /**
     * Click the approve button with the specified text via CDP.
     * @param buttonText Text of the button to click (default: detected approveText or "Allow")
     * @returns true if click succeeded
     */
    async approveButton(buttonText?: string): Promise<boolean> {
        const text = buttonText ?? this.lastDetectedInfo?.approveText ?? 'Allow';
        const clicked = await this.clickButton(text);
        if (clicked) await this.submitIfRequired();
        return clicked;
    }

    /**
     * Select "Allow This Conversation / Always Allow".
     * If the button is not directly visible, expand the Allow Once dropdown and select it.
     */
    async alwaysAllowButton(): Promise<boolean> {
        const directCandidates = [
            this.lastDetectedInfo?.alwaysAllowText,
            'Yes, and always allow',
            'Allow This Conversation',
            'Allow This Chat',
            'この会話を許可',
            'Always Allow',
            '常に許可',
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

        for (const candidate of directCandidates) {
            if (await this.clickButton(candidate)) {
                await this.submitIfRequired();
                return true;
            }
        }

        const expanded = await this.runEvaluateScript(EXPAND_ALWAYS_ALLOW_MENU_SCRIPT);
        if (expanded?.ok !== true) {
            return false;
        }

        for (let i = 0; i < 5; i++) {
            for (const candidate of directCandidates) {
                if (await this.clickButton(candidate)) {
                    await this.submitIfRequired();
                    return true;
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 120));
        }

        return false;
    }

    /**
     * Click the deny button with the specified text via CDP.
     * @param buttonText Text of the button to click (default: detected denyText or "Deny")
     * @returns true if click succeeded
     */
    async denyButton(buttonText?: string): Promise<boolean> {
        const text = buttonText ?? this.lastDetectedInfo?.denyText ?? 'Deny';
        const clicked = await this.clickButton(text);
        if (clicked) await this.submitIfRequired();
        return clicked;
    }

    /**
     * Internal click handler (shared implementation for approveButton / denyButton).
     * Specifies contextId to click in the correct execution context.
     */
    private async clickButton(buttonText: string): Promise<boolean> {
        try {
            const result = await this.runEvaluateScript(buildClickScript(buttonText));
            return result?.ok === true;
        } catch (error) {
            logger.error('[ApprovalDetector] Error while clicking button:', error);
            return false;
        }
    }

    /**
     * Execute Runtime.evaluate and return result.value.
     * Uses the context where buttons were last detected so clicks land in the right frame.
     */
    private async runEvaluateScript(expression: string): Promise<any> {
        const contextId = this.lastDetectedContextId !== undefined
            ? this.lastDetectedContextId
            : this.cdpService.getPrimaryContextId();
        const callParams: Record<string, unknown> = {
            expression,
            returnByValue: true,
            awaitPromise: false,
        };
        if (contextId !== null && contextId !== undefined) {
            callParams.contextId = contextId;
        }
        const result = await this.cdpService.call('Runtime.evaluate', callParams);
        return result?.result?.value;
    }

    /** Click Submit after selecting an option in radio-list permission prompts. */
    private async submitIfRequired(): Promise<boolean> {
        if (!this.lastDetectedInfo?.submitRequired) return true;
        try {
            const result = await this.runEvaluateScript(buildClickScript('Submit'));
            if (result?.ok !== true) {
                logger.warn(`[ApprovalDetector] Submit click failed after selecting permission option: ${JSON.stringify(result)}`);
                return false;
            }
            return true;
        } catch (error) {
            logger.error('[ApprovalDetector] Error while clicking Submit:', error);
            return false;
        }
    }

    /** Returns whether monitoring is currently active */
    isActive(): boolean {
        return this.isRunning;
    }
}
