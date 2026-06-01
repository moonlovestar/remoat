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
const DETECT_APPROVAL_SCRIPT = `(() => {
    // --- Text pattern sets (ordered from most-specific to most-general) ---
    const ALLOW_ONCE_PATTERNS = [
        'yes, allow this time',
        'yes, allow once',
        'allow this time',
        'allow once',
        'allow one time',
        '今回のみ許可',
        '1回のみ許可',
        '一度許可',
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
    const ALLOW_PATTERNS = ['yes, allow', 'allow', 'permit', 'run', 'execute', '許可', '承認', '確認', '実行'];
    const DENY_PATTERNS = [
        "don't run", "don't allow", "don't",
        'no (', 'no,', 'no.', 'no!',
        'deny', 'reject', '拒否', 'decline', '却下', 'skip',
        'cancel', 'not now', 'dismiss', 'close', 'abort',
        'いいえ', 'キャンセル',
    ];

    const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();

    // Collect all visible interactive elements — buttons AND list/option items
    const CLICKABLE_SELECTORS = [
        'button',
        '[role="option"]',
        '[role="listitem"]',
        '[role="menuitem"]',
        'li[tabindex]',
        '[class*="option"][tabindex]',
        '[class*="item"][tabindex]',
    ];
    const allInteractive = Array.from(
        document.querySelectorAll(CLICKABLE_SELECTORS.join(','))
    ).filter(el => el.offsetParent !== null);

    let approveBtn = allInteractive.find(el => {
        const t = normalize(el.textContent || '');
        return ALLOW_ONCE_PATTERNS.some(p => t.includes(p));
    }) || null;

    if (!approveBtn) {
        approveBtn = allInteractive.find(el => {
            const t = normalize(el.textContent || '');
            const isAlways = ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
            return !isAlways && ALLOW_PATTERNS.some(p => t.includes(p));
        }) || null;
    }

    if (!approveBtn) return null;

    // Find container: prefer an ancestor with a role=dialog/modal class,
    // fall back to walking up until we find a sibling deny element.
    let container = approveBtn.closest(
        '[role="dialog"], .modal, .dialog, .approval-container, .permission-dialog, [class*="permission"], [class*="approval"]'
    );
    if (!container) {
        let el = approveBtn.parentElement;
        for (let i = 0; i < 8 && el && el !== document.body; i++) {
            const candidates = Array.from(el.querySelectorAll(CLICKABLE_SELECTORS.join(',')))
                .filter(b => b.offsetParent !== null);
            if (candidates.some(b => DENY_PATTERNS.some(p => normalize(b.textContent || '').includes(p)))) {
                container = el;
                break;
            }
            el = el.parentElement;
        }
    }
    if (!container) container = document.body;

    const containerItems = Array.from(
        container.querySelectorAll(CLICKABLE_SELECTORS.join(','))
    ).filter(el => el.offsetParent !== null);

    const denyBtn = containerItems.find(el => {
        const t = normalize(el.textContent || '');
        return DENY_PATTERNS.some(p => t.includes(p));
    }) || null;

    const alwaysAllowBtn = containerItems.find(el => {
        const t = normalize(el.textContent || '');
        return ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p));
    }) || null;

    const approveText = (approveBtn.textContent || '').trim();
    const alwaysAllowText = alwaysAllowBtn ? (alwaysAllowBtn.textContent || '').trim() : '';
    const denyText = denyBtn ? (denyBtn.textContent || '').trim() : '';

    // --- Description extraction (multiple fallbacks) ---
    let description = '';

    // 1. Dedicated title/description elements in the dialog
    const titleEl = container.querySelector(
        'h1, h2, h3, [role="heading"], [class*="title"], [class*="heading"], [class*="label"]'
    );
    const bodyEl = container.querySelector(
        'p, .description, [data-testid="description"], [class*="body"], [class*="detail"], [class*="subtitle"], code'
    );
    if (titleEl) {
        description = (titleEl.textContent || '').trim();
        // Append a detail line if present (e.g. the URL / domain)
        if (bodyEl) {
            const detail = (bodyEl.textContent || '').trim();
            if (detail && detail !== description) {
                description += ' — ' + detail;
            }
        }
    }

    // 2. Parent element text excluding interactive children
    if (!description) {
        const parent = approveBtn.parentElement?.parentElement || approveBtn.parentElement;
        if (parent) {
            const clone = parent.cloneNode(true);
            clone.querySelectorAll(CLICKABLE_SELECTORS.join(',')).forEach(b => b.remove());
            const parentText = (clone.textContent || '').trim();
            if (parentText.length > 5 && parentText.length < 500) {
                description = parentText;
            }
        }
    }

    // 3. aria-label on container or approve button
    if (!description) {
        description =
            container.getAttribute('aria-label') ||
            container.getAttribute('aria-labelledby') && '' || // just reset
            approveBtn.getAttribute('aria-label') || '';
    }

    return { approveText, alwaysAllowText, denyText, description };
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
        'button',
        '[role="option"]',
        '[role="listitem"]',
        '[role="menuitem"]',
        'li[tabindex]',
        '[class*="option"][tabindex]',
        '[class*="item"][tabindex]',
    ];

    const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
    const visibleItems = Array.from(document.querySelectorAll(CLICKABLE_SELECTORS.join(',')))
        .filter(el => el.offsetParent !== null);

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
        .filter(btn => btn.offsetParent !== null);

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
        const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        const text = ${safeText};
        const wanted = normalize(text);
        // Search buttons AND list/option items for the widest compatibility
        const CLICKABLE_SELECTORS = [
            'button',
            '[role="option"]',
            '[role="listitem"]',
            '[role="menuitem"]',
            'li[tabindex]',
            '[class*="option"][tabindex]',
            '[class*="item"][tabindex]',
        ];
        const allElements = Array.from(document.querySelectorAll(CLICKABLE_SELECTORS.join(',')));
        const target = allElements.find(el => {
            if (!el.offsetParent) return false;
            const elText = normalize(el.textContent || '');
            const ariaLabel = normalize(el.getAttribute('aria-label') || '');
            return elText === wanted ||
                ariaLabel === wanted ||
                elText.includes(wanted) ||
                ariaLabel.includes(wanted);
        });
        if (!target) return { ok: false, error: 'Button not found: ' + text };
        // Dispatch full pointer event sequence for list items that may not respond to .click()
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
    /** Key of the last detected button info (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full ApprovalInfo from the last detection (used for clicking) */
    private lastDetectedInfo: ApprovalInfo | null = null;

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
     *   1. Get approval button info from DOM (with contextId)
     *   2. Notify via callback only on new detection (prevent duplicates)
     *   3. Reset lastDetectedKey / lastDetectedInfo when buttons disappear
     */
    private async poll(): Promise<void> {
        try {
            const contextId = this.cdpService.getPrimaryContextId();
            const callParams: Record<string, unknown> = {
                expression: DETECT_APPROVAL_SCRIPT,
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }

            const result = await this.cdpService.call('Runtime.evaluate', callParams);
            const info: ApprovalInfo | null = result?.result?.value ?? null;

            if (info) {
                // Duplicate prevention: use approveText + description combination as key
                const key = `${info.approveText}::${info.description}`;
                if (key !== this.lastDetectedKey) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    Promise.resolve(this.onApprovalRequired(info)).catch((err) => {
                        logger.error('[ApprovalDetector] onApprovalRequired callback failed:', err);
                    });
                }
            } else {
                // Reset when buttons disappear (prepare for next approval detection)
                const wasDetected = this.lastDetectedKey !== null;
                this.lastDetectedKey = null;
                this.lastDetectedInfo = null;
                if (wasDetected && this.onResolved) {
                    this.onResolved();
                }
            }
        } catch (error) {
            // Ignore CDP errors and continue monitoring
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('WebSocket is not connected') || message.includes('WebSocket disconnected')) {
                return;
            }
            logger.error('[ApprovalDetector] Error during polling:', error);
        }
    }

    /**
     * Click the approve button with the specified text via CDP.
     * @param buttonText Text of the button to click (default: detected approveText or "Allow")
     * @returns true if click succeeded
     */
    async approveButton(buttonText?: string): Promise<boolean> {
        const text = buttonText ?? this.lastDetectedInfo?.approveText ?? 'Allow';
        return this.clickButton(text);
    }

    /**
     * Select "Allow This Conversation / Always Allow".
     * If the button is not directly visible, expand the Allow Once dropdown and select it.
     */
    async alwaysAllowButton(): Promise<boolean> {
        const directCandidates = [
            this.lastDetectedInfo?.alwaysAllowText,
            'Allow This Conversation',
            'Allow This Chat',
            'この会話を許可',
            'Always Allow',
            '常に許可',
        ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

        for (const candidate of directCandidates) {
            if (await this.clickButton(candidate)) return true;
        }

        const expanded = await this.runEvaluateScript(EXPAND_ALWAYS_ALLOW_MENU_SCRIPT);
        if (expanded?.ok !== true) {
            return false;
        }

        for (let i = 0; i < 5; i++) {
            for (const candidate of directCandidates) {
                if (await this.clickButton(candidate)) return true;
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
        return this.clickButton(text);
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
     * Execute Runtime.evaluate with contextId and return result.value.
     */
    private async runEvaluateScript(expression: string): Promise<any> {
        const contextId = this.cdpService.getPrimaryContextId();
        const callParams: Record<string, unknown> = {
            expression,
            returnByValue: true,
            awaitPromise: false,
        };
        if (contextId !== null) {
            callParams.contextId = contextId;
        }
        const result = await this.cdpService.call('Runtime.evaluate', callParams);
        return result?.result?.value;
    }

    /** Returns whether monitoring is currently active */
    isActive(): boolean {
        return this.isRunning;
    }
}
