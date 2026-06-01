import { logger } from '../utils/logger';
import { buildClickScript } from './approvalDetector';
import { CdpService } from './cdpService';

/** Planning mode button information */
export interface PlanningInfo {
    /** Open button text */
    openText: string;
    /** Proceed button text */
    proceedText: string | null;
    /** Plan title (file name shown in the card) */
    planTitle: string;
    /** Plan summary text */
    planSummary: string;
    /** Plan description (markdown rendered in leading-relaxed container) */
    description: string;
    /**
     * True when the plan was detected as a plain file reference ("Files Modified" row)
     * with no interactive buttons. The Telegram UI should present synthetic Open/Proceed
     * buttons and must NOT call clickOpenButton() since there is nothing to click.
     */
    fileRefMode?: boolean;
}

export interface PlanningDetectorOptions {
    /** CDP service instance */
    cdpService: CdpService;
    /** Poll interval in milliseconds (default: 2000ms) */
    pollIntervalMs?: number;
    /** Callback when planning buttons are detected */
    onPlanningRequired: (info: PlanningInfo) => void;
    /** Callback when a previously detected planning state is resolved (buttons disappeared) */
    onResolved?: () => void;
    /** Callback when a read-only artifact (Walkthrough, Task) is auto-opened (no Proceed button) */
    onAutoOpened?: (chipText: string) => void;
    /** Callback when a permission approval dialog is detected inside a notify-user-container */
    onApprovalRequest?: (info: import('./approvalDetector').ApprovalInfo) => void;
}

/**
 * Selector that matches Antigravity artifact chips.
 *
 * Live DOM inspection confirmed the chip container uses:
 *   div.border.border-gray-500/20.p-2.my-0.5.rounded-lg.transition-colors.flex.flex-col.gap-2.items-start.select-none
 *
 * Key classes:
 *   1. "border-gray-500" — the border colour token (unique to plan chips)
 *   2. "select-none"     — non-selectable text (unique to chip styling)
 *
 * NOTE: "cursor-pointer" is NOT on the chip container — it's only on inner
 * elements. Prior selector was broken because of this false requirement.
 */
const ARTIFACT_CHIP_SELECTOR =
    'div[class*="border-gray-500"][class*="select-none"]';

/**
 * Baseline capture script — returns counts of existing artifacts in the DOM.
 * Called once when monitoring begins to establish what already exists.
 * Also captures the count of implementation-plan-icon elements for the
 * "Files Modified" detection path.
 */
const CAPTURE_BASELINE_SCRIPT = `(() => {
    const chipSelector = '${ARTIFACT_CHIP_SELECTOR}';
    return {
        notifyCount: document.querySelectorAll('.notify-user-container').length,
        cardCount: document.querySelectorAll(chipSelector).length,
        iconCount: document.querySelectorAll('[class*="implementation-plan-icon"]').length
    };
})()`;

/**
 * Detection script for the Antigravity UI planning mode.
 *
 * Uses baseline counts to skip artifacts that existed BEFORE the current session.
 * Only considers .notify-user-container elements and artifact cards at indices
 * >= the baseline counts, ensuring old session artifacts are never detected.
 */
const buildDetectPlanningScript = (
    lastClickedText: string | null,
    baselineNotifyCount: number,
    baselineCardCount: number,
    baselineIconCount: number,
) => `(() => {
    const OPEN_PATTERNS = ['open', 'view'];
    const PROCEED_PATTERNS = ['proceed', 'accept', 'approve', 'continue'];
    /**
     * Artifact types that require user decision (Proceed + Open) or at least
     * a Telegram notification (Open-only). These are NOT auto-opened silently.
     */
    const PLAN_TYPE_KEYWORDS = ['implementation plan', 'implementation_plan', 'plan', 'walkthrough', 'task'];

    // Approval-dialog patterns — checked whenever a new notify-user-container is found
    const ALLOW_ONCE_PATTERNS = ['yes, allow this time', 'yes, allow once', 'allow this time', 'allow once', 'allow one time', '今回のみ許可', '1回のみ許可', '一度許可', '同意授權'];
    const ALWAYS_ALLOW_PATTERNS = ['yes, and always allow', 'yes, always allow', 'allow this conversation', 'allow this chat', 'always allow', '常に許可', 'この会話を許可'];
    const ALLOW_PATTERNS = ['yes, allow', 'allow', 'permit', 'run', 'execute', '許可', '承認', '確認', '実行', '同意授權'];
    const DENY_PATTERNS = ["don't run", "don't allow", "don't", 'no (', 'no,', 'no.', 'no!', 'deny', 'reject', '拒否', 'decline', '却下', 'skip', 'cancel', 'not now', 'dismiss', 'close', 'abort', 'いいえ', 'キャンセル', '拒絕授權', 'other (write your answer)'];

    // Check a DOM scope for allow/deny buttons; returns approval info or null
    function detectApproval(scope) {
        const btns = Array.from(scope.querySelectorAll('button, [role="button"]'))
            .filter(b => b.offsetParent !== null || (b.getBoundingClientRect().width > 0 && b.getBoundingClientRect().height > 0));
        const norm = (t) => (t || '').toLowerCase().replace(/\\s+/g, ' ').trim();
        let approveBtn = btns.find(b => ALLOW_ONCE_PATTERNS.some(p => norm(b.textContent).includes(p))) || null;
        if (!approveBtn) approveBtn = btns.find(b => { const t = norm(b.textContent); return !ALWAYS_ALLOW_PATTERNS.some(p => t.includes(p)) && ALLOW_PATTERNS.some(p => t.includes(p)); }) || null;
        if (!approveBtn) return null;
        const denyBtn = btns.find(b => DENY_PATTERNS.some(p => norm(b.textContent).includes(p))) || null;
        const alwaysAllowBtn = btns.find(b => ALWAYS_ALLOW_PATTERNS.some(p => norm(b.textContent).includes(p))) || null;
        const titleEl = scope.querySelector('h1, h2, h3, [role="heading"], [class*="title"], [class*="heading"]');
        const bodyEl = scope.querySelector('p, .description, [class*="body"], [class*="detail"], code');
        let description = titleEl ? (titleEl.textContent || '').trim() : '';
        if (description && bodyEl) { const d = (bodyEl.textContent || '').trim(); if (d && d !== description) description += ' — ' + d; }
        if (!description) { const clone = approveBtn.parentElement?.cloneNode(true); if (clone) { clone.querySelectorAll('button,[role="button"]').forEach(x => x.remove()); const t = (clone.textContent || '').trim(); if (t.length > 5 && t.length < 500) description = t; } }
        return { isApprovalRequest: true, approveText: (approveBtn.textContent || '').trim(), alwaysAllowText: alwaysAllowBtn ? (alwaysAllowBtn.textContent || '').trim() : '', denyText: denyBtn ? (denyBtn.textContent || '').trim() : '', description };
    }

    const lastClickedText = ${lastClickedText ? JSON.stringify(lastClickedText) : 'null'};
    const BASELINE_NOTIFY = ${baselineNotifyCount};
    const BASELINE_CARD = ${baselineCardCount};
    const BASELINE_ICON = ${baselineIconCount};

    const normalize = (text) => (text || '').toLowerCase().replace(/\\s+/g, ' ').trim();

    // Only consider .notify-user-container elements beyond the baseline
    const allContainers = Array.from(document.querySelectorAll('.notify-user-container'));
    const newContainers = allContainers.slice(BASELINE_NOTIFY);
    let container = newContainers.length > 0 ? newContainers[newContainers.length - 1] : null;
    let openBtn = null;
    let proceedBtn = null;

    if (container) {
        // Check for approval request first — permission dialogs share this container class
        const approvalResult = detectApproval(container) || (container.parentElement ? detectApproval(container.parentElement) : null);
        if (approvalResult) return approvalResult;

        const allButtons = Array.from(container.querySelectorAll('button')).filter(btn => btn.offsetParent !== null);
        openBtn = allButtons.find(btn => { const t = normalize(btn.textContent); return OPEN_PATTERNS.some(p => t === p || t.includes(p)); });
        proceedBtn = allButtons.find(btn => { const t = normalize(btn.textContent); return PROCEED_PATTERNS.some(p => t === p || t.includes(p)); });
    }

    // If no container found in new containers, check for loose buttons in new containers only
    if (!openBtn && newContainers.length > 0) {
        for (let ci = newContainers.length - 1; ci >= 0; ci--) {
            const c = newContainers[ci];
            // Check for approval request before planning detection
            const approvalResult = detectApproval(c) || (c.parentElement ? detectApproval(c.parentElement) : null);
            if (approvalResult) return approvalResult;

            const btns = Array.from(c.querySelectorAll('button')).filter(btn => btn.offsetParent !== null);
            const ob = btns.find(btn => { const t = normalize(btn.textContent); return OPEN_PATTERNS.some(p => t === p || t.includes(p)); });
            if (ob) {
                openBtn = ob;
                container = c;
                proceedBtn = btns.find(btn => { const t = normalize(btn.textContent); return PROCEED_PATTERNS.some(p => t === p || t.includes(p)); });
                break;
            }
        }
    }

    // Fallback: Check for collapsed/expanded artifact chips beyond baseline.
    // Antigravity renders artifact chips as div.border-gray.cursor-pointer blocks.
    // Collapsed chips have NO buttons — clicking expands them to reveal Proceed/Open.
    // Expanded chips contain Proceed/Open buttons directly inside the div.
    if (!openBtn || !container) {
        const chipSelector = '${ARTIFACT_CHIP_SELECTOR}';
        const allCards = Array.from(document.body.querySelectorAll(chipSelector))
            .filter(el => el.offsetParent !== null);
        const newCards = allCards.slice(BASELINE_CARD);

        // Iterate backwards to process the newest artifacts first
        for (let i = newCards.length - 1; i >= 0; i--) {
            const card = newCards[i];
            const cardText = (card.textContent || '').trim();
            if (!cardText || cardText.length > 500) continue;

            // Check if card is EXPANDED (has Open/Proceed buttons inside)
            const buttons = Array.from(card.querySelectorAll('button'))
                .filter(btn => btn.offsetParent !== null);
            const ob = buttons.find(btn => {
                const t = normalize(btn.textContent);
                return OPEN_PATTERNS.some(p => t === p || t.includes(p));
            });
            const pb = buttons.find(btn => {
                const t = normalize(btn.textContent);
                return PROCEED_PATTERNS.some(p => t === p || t.includes(p));
            });

            if (ob) {
                if (!pb) {
                    // Open-only chip: determine if it's a plan-type artifact.
                    // Plan-types (implementation plan, walkthrough, task) must go through
                    // Telegram notification so the user can decide — NOT auto-opened.
                    const cardNorm = normalize(card.textContent);
                    const isPlanType = PLAN_TYPE_KEYWORDS.some(k => cardNorm.includes(k))
                        || !!card.querySelector('[class*="implementation-plan-icon"]')
                        || !!card.querySelector('[class*="walkthrough-icon"]')
                        || !!card.querySelector('[class*="task-icon"]');

                    if (isPlanType) {
                        // Needs a Telegram notification — hand off as a full plan detection with no proceedText
                        openBtn = ob;
                        proceedBtn = null;
                        container = card;
                        break;
                    }

                    // Non-plan open-only artifact — auto-open silently as before
                    const nameSpans = Array.from(card.querySelectorAll('span'))
                        .map(s => (s.textContent || '').trim())
                        .filter(t => t.length > 0 && t.length < 60
                            && !OPEN_PATTERNS.some(p => normalize(t) === p || normalize(t).includes(p)));
                    ob.click();
                    return { autoOpened: true, chipText: nameSpans[0] || 'Artifact' };
                }
                // Has both Open AND Proceed — needs user decision
                openBtn = ob;
                proceedBtn = pb;
                container = card;
                break;
            }

            // COLLAPSED chip (no visible buttons yet) — check if it's a plan type by icon.
            // Plan-type chips must be expanded via click so their buttons can be detected
            // on the next poll cycle. Non-plan chips are ignored to avoid false positives.
            const hasPlanIcon = !!card.querySelector('[class*="implementation-plan-icon"]')
                || !!card.querySelector('[class*="walkthrough-icon"]')
                || !!card.querySelector('[class*="task-icon"]');
            const cardTextNorm = normalize(card.textContent);
            const looksLikePlan = hasPlanIcon || PLAN_TYPE_KEYWORDS.some(k => cardTextNorm.includes(k));

            if (looksLikePlan) {
                // Try inner clickable span first, then the div itself.
                const innerChip = card.querySelector('span[class*="inline-flex"][class*="cursor-pointer"]');
                const clickTarget = innerChip || (card.classList.contains('cursor-pointer') ? card : null);
                if (clickTarget) {
                    const chipText = (clickTarget.textContent || '').trim();
                    if (chipText && chipText !== lastClickedText && chipText.length < 100) {
                        clickTarget.click();
                        return { collapsed: true, chipText };
                    }
                }
            }
        }

        if (!openBtn) {
            // ── 4th detection pass: "Files Modified" file-reference chips ────────────
            // These chips have the implementation-plan-icon but NO buttons (not rendered
            // as a notify-user-container or border-gray chip). They appear as plain file
            // references under the "Files Modified" header of an AI response.
            const allIconEls = Array.from(document.querySelectorAll('[class*="implementation-plan-icon"]'))
                .filter(el => el.offsetParent !== null);
            const newIconEls = allIconEls.slice(BASELINE_ICON);

            for (let k = newIconEls.length - 1; k >= 0; k--) {
                const iconEl = newIconEls[k];
                // Walk up to find the clickable file-reference row
                let refEl = iconEl.parentElement;
                for (let up = 0; up < 5 && refEl; up++) {
                    if (refEl.classList.contains('cursor-pointer') || refEl.getAttribute('role') === 'button') break;
                    refEl = refEl.parentElement;
                }

                // Extract plan title from the icon's sibling text.
                // The monaco-icon-label includes both the type prefix (e.g. "Implementation Plan")
                // and the actual filename — strip the known prefix to get just the file name.
                const titleNode = iconEl.closest('[class*="monaco-icon-label"]') ||
                    iconEl.parentElement;
                const rawTitle = (titleNode?.textContent || '').trim();
                // Remove leading type-prefix tokens so "Implementation PlanFoo Bar" → "Foo Bar"
                const PLAN_PREFIX_RE = /^(implementation plan|implementation_plan|walkthrough|task)\s*/i;
                const planTitle = rawTitle.replace(PLAN_PREFIX_RE, '').trim() || rawTitle || 'Implementation Plan';

                // Synthesize openText since there's no actual Open button
                return {
                    openText: 'Open',
                    proceedText: null,
                    planTitle,
                    planSummary: '',
                    description: '',
                    fileRefMode: true, // Signal to TypeScript layer that there's no button to click
                };
            }

            return null; // No new artifacts found
        }
    }

    const openText = (openBtn.textContent || '').trim();
    const proceedText = proceedBtn ? (proceedBtn.textContent || '').trim() : null;

    // Extract plan title from .inline-flex.break-all or .font-mono
    const titleEl = container.querySelector('span.inline-flex.break-all, .inline-flex.break-all, span.break-all, span.select-text.break-all, .font-mono.text-sm.truncate, .font-mono.truncate');
    let planTitle = titleEl ? (titleEl.textContent || '').trim() : '';

    if (!planTitle && openText) {
        const match = openText.match(/open\\s+(.*)/i);
        if (match) planTitle = match[1].trim();
    }

    // Extract plan summary from span.text-sm (excluding buttons text)
    const summaryEls = Array.from(container.querySelectorAll('span.text-sm'));
    const planSummary = summaryEls
        .map(el => (el.textContent || '').trim())
        .filter(text => text.length > 0 && text !== openText && text !== proceedText && text !== planTitle)
        .join(' ');

    // Extract description from leading-relaxed container, skipping code/style blocks.
    // Fallback: if no .leading-relaxed found (chip-based layout), collect all non-button
    // text from the container minus title/summary text.
    const descEl = container.querySelector('.leading-relaxed.select-text');
    let description = '';
    const SKIP_TAGS = new Set(['PRE', 'CODE', 'STYLE', 'SCRIPT', 'BUTTON']);
    const walkToText = (el) => {
        const parts = [];
        const walk = (node) => {
            if (node.nodeType === 3) {
                const t = node.textContent || '';
                if (t.trim()) parts.push(t.trim());
            } else if (node.nodeType === 1 && !SKIP_TAGS.has(node.tagName)) {
                for (const child of node.childNodes) walk(child);
            }
        };
        walk(el);
        return parts.join(' ').slice(0, 500);
    };
    if (descEl) {
        description = walkToText(descEl);
    } else {
        // Chip-based layout: extract all container text excluding buttons and title
        const fullText = walkToText(container);
        // Remove the title and button text from the full container text
        const strippedParts = [planTitle, openText, proceedText, planSummary].filter(Boolean);
        description = strippedParts.reduce((t, s) => t.replace(s, ''), fullText).replace(/\\s+/g, ' ').trim();
    }

    return { openText, proceedText, planTitle, planSummary, description };
})()`;

/**
 * Extract plan content displayed after clicking Open.
 *
 * Looks for the rendered markdown inside the plan content area
 * and returns the text, truncated to 4000 characters for Telegram message limits.
 */
/**
 * Build plan content extraction script with baseline counts.
 * Only extracts content from artifacts beyond the baseline.
 */
const buildExtractPlanContentScript = (
    baselineNotifyCount: number,
    baselineCardCount: number,
) => `(() => {
    const BASELINE_NOTIFY = ${baselineNotifyCount};
    const BASELINE_CARD = ${baselineCardCount};

    // Simple HTML-to-Markdown converter for plan content
    const htmlToMd = (el) => {
        const parts = [];
        const process = (node) => {
            if (node.nodeType === 3) {
                parts.push(node.textContent || '');
                return;
            }
            if (node.nodeType !== 1) return;
            const tag = node.tagName;
            if (tag === 'H1') { parts.push('\\n# '); node.childNodes.forEach(process); parts.push('\\n'); return; }
            if (tag === 'H2') { parts.push('\\n## '); node.childNodes.forEach(process); parts.push('\\n'); return; }
            if (tag === 'H3') { parts.push('\\n### '); node.childNodes.forEach(process); parts.push('\\n'); return; }
            if (tag === 'H4') { parts.push('\\n#### '); node.childNodes.forEach(process); parts.push('\\n'); return; }
            if (tag === 'STRONG' || tag === 'B') { parts.push('**'); node.childNodes.forEach(process); parts.push('**'); return; }
            if (tag === 'EM' || tag === 'I') { parts.push('*'); node.childNodes.forEach(process); parts.push('*'); return; }
            if (tag === 'PRE') {
                const code = node.querySelector('code');
                const text = code ? (code.textContent || '') : (node.textContent || '');
                parts.push('\\n\`\`\`\\n' + text + '\\n\`\`\`\\n');
                return;
            }
            if (tag === 'CODE') { parts.push('\`' + (node.textContent || '') + '\`'); return; }
            if (tag === 'A') {
                const href = node.getAttribute('href') || '';
                parts.push('['); node.childNodes.forEach(process); parts.push('](' + href + ')');
                return;
            }
            if (tag === 'LI') { parts.push('\\n- '); node.childNodes.forEach(process); return; }
            if (tag === 'BR') { parts.push('\\n'); return; }
            if (tag === 'P') { parts.push('\\n\\n'); node.childNodes.forEach(process); parts.push('\\n'); return; }
            if (tag === 'UL' || tag === 'OL') { node.childNodes.forEach(process); parts.push('\\n'); return; }
            if (tag === 'STYLE' || tag === 'SCRIPT') return;
            node.childNodes.forEach(process);
        };
        process(el);
        return parts.join('').replace(/\\n{3,}/g, '\\n\\n').trim();
    };

    // Only look at NEW notify containers (beyond baseline)
    const allContainers = Array.from(document.querySelectorAll('.notify-user-container'));
    const newContainers = allContainers.slice(BASELINE_NOTIFY);

    // Try extracting from the newest new container first
    for (let i = newContainers.length - 1; i >= 0; i--) {
        const container = newContainers[i];
        // Look for content inside the container
        const contentDiv = container.querySelector('div.relative.pl-4.pr-4.py-1, div.relative.pl-4.pr-4');
        if (contentDiv) {
            const textEl = contentDiv.querySelector('.leading-relaxed.select-text');
            if (textEl) return htmlToMd(textEl);
        }
        // Direct leading-relaxed inside container
        const directLeading = container.querySelector('.leading-relaxed.select-text');
        if (directLeading) {
            const md = htmlToMd(directLeading);
            if (md.length > 50) return md;
        }
    }

    // Fallback: look for new artifact cards/chips beyond baseline
    const chipSelector = '${ARTIFACT_CHIP_SELECTOR}';
    const allCards = Array.from(document.body.querySelectorAll(chipSelector));
    const newCards = allCards.slice(BASELINE_CARD);
    for (let i = newCards.length - 1; i >= 0; i--) {
        const card = newCards[i];
        const textEl = card.querySelector('.leading-relaxed.select-text');
        if (textEl) {
            const md = htmlToMd(textEl);
            if (md.length > 50) return md;
        }
    }

    // Last resort: any content container beyond baseline position-wise
    const allContentDivs = Array.from(document.querySelectorAll('div.relative.pl-4.pr-4.py-1, div.relative.pl-4.pr-4'));
    const newContentDivs = allContentDivs.slice(Math.max(BASELINE_NOTIFY, 0));
    for (let i = newContentDivs.length - 1; i >= 0; i--) {
        const textEl = newContentDivs[i].querySelector('.leading-relaxed.select-text');
        if (textEl) return htmlToMd(textEl);
    }

    return null;
})()`;

/**
 * Detects planning mode buttons (Open/Proceed) in the Antigravity UI via polling.
 *
 * Follows the same polling pattern as ApprovalDetector:
 * - start()/stop() lifecycle
 * - Duplicate notification prevention via lastDetectedKey
 * - CDP error tolerance (continues polling on error)
 */
export class PlanningDetector {
    private cdpService: CdpService;
    private pollIntervalMs: number;
    private onPlanningRequired: (info: PlanningInfo) => void;
    private onResolved?: () => void;
    private onAutoOpened?: (chipText: string) => void;
    private onApprovalRequest?: (info: import('./approvalDetector').ApprovalInfo) => void;

    private pollTimer: NodeJS.Timeout | null = null;
    private isRunning: boolean = false;
    /** Key of the last detected planning info (for duplicate notification prevention) */
    private lastDetectedKey: string | null = null;
    /** Full PlanningInfo from the last detection */
    private lastDetectedInfo: PlanningInfo | null = null;
    /** Timestamp of last notification (for cooldown-based dedup) */
    private lastNotifiedAt: number = 0;
    /** Cooldown period in ms to suppress duplicate notifications */
    private static readonly COOLDOWN_MS = 5000;

    /** Click-guard state to prevent infinite auto-click loops on collapsed cards */
    private lastClickedChip: { text: string; at: number } | null = null;

    /**
     * Baseline artifact counts captured when monitoring starts.
     * Artifacts at indices < baseline are from previous sessions and are ignored.
     */
    private baselineNotifyCount: number = 0;
    private baselineCardCount: number = 0;
    private baselineIconCount: number = 0;

    constructor(options: PlanningDetectorOptions) {
        this.cdpService = options.cdpService;
        this.pollIntervalMs = options.pollIntervalMs ?? 2000;
        this.onPlanningRequired = options.onPlanningRequired;
        this.onResolved = options.onResolved;
        this.onAutoOpened = options.onAutoOpened;
        this.onApprovalRequest = options.onApprovalRequest;
    }

    /**
     * Start monitoring.
     *
     * Captures a DOM baseline BEFORE the first poll so that any plan artifacts
     * already in the DOM (e.g. from a prior session) are never treated as new
     * detections and do not produce false-positive Telegram notifications.
     */
    start(): void {
        if (this.isRunning) return;
        this.isRunning = true;
        this.lastDetectedKey = null;
        this.lastDetectedInfo = null;
        this.lastNotifiedAt = 0;
        this.lastClickedChip = null;
        // Capture baseline before the first poll — runs async but schedules
        // the first poll only after the baseline is safely captured.
        this.resetBaseline().finally(() => {
            if (this.isRunning) this.schedulePoll();
        });
    }

    /**
     * Capture a baseline snapshot of existing artifacts in the DOM.
     * Must be called BEFORE a new message is submitted so that
     * detection only triggers on NEW artifacts from the current session.
     */
    async resetBaseline(): Promise<void> {
        try {
            const result = await this.runEvaluateScript(CAPTURE_BASELINE_SCRIPT);
            this.baselineNotifyCount = result?.notifyCount ?? 0;
            this.baselineCardCount = result?.cardCount ?? 0;
            this.baselineIconCount = result?.iconCount ?? 0;
            // Reset detection state so new plans can be detected
            this.lastDetectedKey = null;
            this.lastDetectedInfo = null;
            this.lastNotifiedAt = 0;
            this.lastClickedChip = null;
            logger.debug(
                `[PlanningDetector] Baseline captured: ${this.baselineNotifyCount} notify containers, ` +
                `${this.baselineCardCount} chips, ${this.baselineIconCount} plan icons`,
            );
        } catch (error) {
            logger.error('[PlanningDetector] Failed to capture baseline:', error);
            // On failure, keep existing baselines (safe: won't detect old artifacts)
        }
    }

    /** Get the current baseline counts (for passing to other scripts) */
    getBaseline(): { notifyCount: number; cardCount: number; iconCount: number } {
        return {
            notifyCount: this.baselineNotifyCount,
            cardCount: this.baselineCardCount,
            iconCount: this.baselineIconCount,
        };
    }

    /** Stop monitoring. */
    async stop(): Promise<void> {
        this.isRunning = false;
        this.lastClickedChip = null;
        if (this.pollTimer) {
            clearTimeout(this.pollTimer);
            this.pollTimer = null;
        }
    }

    /** Return the last detected planning info. Returns null if nothing has been detected. */
    getLastDetectedInfo(): PlanningInfo | null {
        return this.lastDetectedInfo;
    }

    /** Returns whether monitoring is currently active. */
    isActive(): boolean {
        return this.isRunning;
    }

    /**
     * Click the Open button via CDP.
     * @param buttonText Text of the button to click (default: detected openText or "Open")
     * @returns true if click succeeded
     */
    async clickOpenButton(buttonText?: string): Promise<boolean> {
        const text = buttonText ?? this.lastDetectedInfo?.openText ?? 'Open';
        return this.clickButton(text);
    }

    /**
     * Click the Proceed button via CDP.
     * @param buttonText Text of the button to click (default: detected proceedText or "Proceed")
     * @returns true if click succeeded
     */
    async clickProceedButton(buttonText?: string): Promise<boolean> {
        const text = buttonText ?? this.lastDetectedInfo?.proceedText ?? 'Proceed';
        return this.clickButton(text);
    }

    /**
     * Extract plan content from the DOM after Open has been clicked.
     * @returns Plan content text or null if not found
     */
    async extractPlanContent(): Promise<string | null> {
        try {
            const script = buildExtractPlanContentScript(this.baselineNotifyCount, this.baselineCardCount);
            const result = await this.runEvaluateScript(script);
            return typeof result === 'string' ? result : null;
        } catch (error) {
            logger.error('[PlanningDetector] Error extracting plan content:', error);
            return null;
        }
    }

    /** Schedule the next poll. */
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
     *   1. Get planning button info from DOM (with contextId)
     *   2. Notify via callback only on new detection (prevent duplicates)
     *   3. Reset lastDetectedKey / lastDetectedInfo when buttons disappear
     */
    private async poll(): Promise<void> {
        try {
            // Expire click-guard state after 10 seconds
            if (this.lastClickedChip && Date.now() - this.lastClickedChip.at > 10000) {
                this.lastClickedChip = null;
            }

            const contextId = this.cdpService.getPrimaryContextId();
            const callParams: Record<string, unknown> = {
                expression: buildDetectPlanningScript(
                    this.lastClickedChip?.text || null,
                    this.baselineNotifyCount,
                    this.baselineCardCount,
                    this.baselineIconCount,
                ),
                returnByValue: true,
                awaitPromise: false,
            };
            if (contextId !== null) {
                callParams.contextId = contextId;
            }

            const result = await this.cdpService.call('Runtime.evaluate', callParams);

            // Expected shape: PlanningInfo | PlanningInfo+fileRefMode | { collapsed: true, chipText } | { autoOpened: true, chipText } | null
            const payload = result?.result?.value ?? null;

            if (payload && payload.collapsed) {
                // We just initiated an auto-click on a collapsed chip
                this.lastClickedChip = { text: payload.chipText, at: Date.now() };
                logger.debug(`[PlanningDetector] Auto-clicked collapsed artifact chip: "${payload.chipText}"`);
                return; // Wait for the next poll cycle to detect the expanded buttons
            }

            if (payload && payload.autoOpened) {
                // Read-only artifact (Walkthrough, Task) was auto-opened — send lightweight notification
                this.lastClickedChip = null;
                logger.info(`[PlanningDetector] Auto-opened read-only artifact: "${payload.chipText}"`);
                if (this.onAutoOpened) {
                    Promise.resolve(this.onAutoOpened(payload.chipText)).catch((err) => {
                        logger.error('[PlanningDetector] onAutoOpened callback failed:', err);
                    });
                }
                return;
            }

            if (payload && payload.isApprovalRequest) {
                // Permission dialog detected inside a notify-user-container — route to approval handler
                this.lastClickedChip = null;
                logger.info(`[PlanningDetector] Approval request detected: "${payload.approveText}" / "${payload.denyText}"`);
                if (this.onApprovalRequest) {
                    Promise.resolve(this.onApprovalRequest(payload)).catch((err) => {
                        logger.error('[PlanningDetector] onApprovalRequest callback failed:', err);
                    });
                }
                return;
            }

            const info: PlanningInfo | null = payload;

            if (info) {
                // Clear click-guard state (successful expansion)
                this.lastClickedChip = null;

                // Duplicate prevention: use button text + content preview as key (stable across DOM redraws, unique per plan)
                const uniquePreview = `${info.planTitle}::${info.planSummary.slice(0, 50)}::${info.description.slice(0, 50)}`;
                const key = `${info.openText}::${info.proceedText}::${uniquePreview}`;
                const now = Date.now();
                const withinCooldown = (now - this.lastNotifiedAt) < PlanningDetector.COOLDOWN_MS;

                // Allow "upgrade" notifications: if the previous detection was fileRefMode or had no
                // proceedText, and the new detection has a real Proceed button, always re-notify —
                // this is a better version of the same plan and the user must be able to Proceed.
                const isUpgrade = !!(info.proceedText &&
                    this.lastDetectedInfo &&
                    (this.lastDetectedInfo.fileRefMode || !this.lastDetectedInfo.proceedText));

                if (key !== this.lastDetectedKey && (!withinCooldown || isUpgrade)) {
                    this.lastDetectedKey = key;
                    this.lastDetectedInfo = info;
                    this.lastNotifiedAt = now;
                    Promise.resolve(this.onPlanningRequired(info)).catch((err) => {
                        logger.error('[PlanningDetector] onPlanningRequired callback failed:', err);
                    });
                } else if (key === this.lastDetectedKey) {
                    // Same key — update stored info silently
                    this.lastDetectedInfo = info;
                }

            } else {
                // Reset when buttons disappear (prepare for next planning detection)
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
            logger.error('[PlanningDetector] Error during polling:', error);
        }
    }

    /** Internal click handler using buildClickScript from approvalDetector. */
    private async clickButton(buttonText: string): Promise<boolean> {
        try {
            const result = await this.runEvaluateScript(buildClickScript(buttonText));
            return result?.ok === true;
        } catch (error) {
            logger.error('[PlanningDetector] Error while clicking button:', error);
            return false;
        }
    }

    /** Execute Runtime.evaluate with contextId and return result.value. */
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
}
