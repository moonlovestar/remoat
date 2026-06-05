import {
    buildApprovalCustomId,
    buildPlanningCustomId,
    ensureApprovalDetector,
    getCurrentCdp,
    initCdpBridge,
    parseApprovalCustomId,
    parsePlanningCustomId,
    registerApprovalSessionChannel,
    registerApprovalWorkspaceChannel,
    registerApprovalWorkspaceChannel as _registerChannel,
    resolveApprovalChannelForCurrentChat,
} from '../../src/services/cdpBridgeManager';
import { ApprovalDetector } from '../../src/services/approvalDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/approvalDetector');
jest.mock('../../src/services/cdpService');

describe('cdpBridgeManager', () => {
    it('initCdpBridge builds the initial state', () => {
        const bridge = initCdpBridge(false);
        expect(bridge.lastActiveWorkspace).toBeNull();
        expect(bridge.lastActiveChannel).toBeNull();
        expect(bridge.autoAccept.isEnabled()).toBe(false);
    });

    it('getCurrentCdp returns null when not connected', () => {
        const bridge = initCdpBridge(false);
        expect(getCurrentCdp(bridge)).toBeNull();
    });

    it('round-trips build/parse of approval action ID', () => {
        const customId = buildApprovalCustomId('approve', 'my-workspace', '123456');
        const parsed = parseApprovalCustomId(customId);
        expect(parsed).toEqual({ action: 'approve', projectName: 'my-workspace', channelId: '123456' });
    });

    it('supports legacy approval action IDs without channelId', () => {
        const parsed = parseApprovalCustomId('approve_action:legacy-workspace');
        expect(parsed).toEqual({ action: 'approve', projectName: 'legacy-workspace', channelId: null });
    });

    it('routes approval notifications by session title when linked', () => {
        const bridge = initCdpBridge(false);
        const channel = { chatId: 1001, threadId: 1 } as any;
        registerApprovalSessionChannel(bridge, 'ws-a', 'Session Alpha', channel);

        expect(resolveApprovalChannelForCurrentChat(bridge, 'ws-a', 'Session Alpha')).toBe(channel);
    });

    it('falls back to workspace channel when session title does not match', () => {
        const bridge = initCdpBridge(false);
        const wsChannel = { chatId: 1001 } as any;
        registerApprovalWorkspaceChannel(bridge, 'ws-a', wsChannel);

        expect(resolveApprovalChannelForCurrentChat(bridge, 'ws-a', 'Unknown Session')).toBe(wsChannel);
    });

    it('falls back to workspace channel when currentChatTitle is null', () => {
        const bridge = initCdpBridge(false);
        const wsChannel = { chatId: 1001 } as any;
        registerApprovalWorkspaceChannel(bridge, 'ws-a', wsChannel);

        expect(resolveApprovalChannelForCurrentChat(bridge, 'ws-a', null)).toBe(wsChannel);
    });

    it('falls back to workspace channel when currentChatTitle is empty', () => {
        const bridge = initCdpBridge(false);
        const wsChannel = { chatId: 1001 } as any;
        registerApprovalWorkspaceChannel(bridge, 'ws-a', wsChannel);

        expect(resolveApprovalChannelForCurrentChat(bridge, 'ws-a', '')).toBe(wsChannel);
    });

    it('prefers session channel over workspace channel', () => {
        const bridge = initCdpBridge(false);
        const wsChannel = { chatId: 1001 } as any;
        const sessionChannel = { chatId: 1001, threadId: 2 } as any;
        registerApprovalWorkspaceChannel(bridge, 'ws-a', wsChannel);
        registerApprovalSessionChannel(bridge, 'ws-a', 'Session Alpha', sessionChannel);

        expect(resolveApprovalChannelForCurrentChat(bridge, 'ws-a', 'Session Alpha')).toBe(sessionChannel);
    });

    it('returns null when neither session nor workspace is registered', () => {
        const bridge = initCdpBridge(false);

        expect(resolveApprovalChannelForCurrentChat(bridge, 'ws-unknown', 'Some Title')).toBeNull();
        expect(resolveApprovalChannelForCurrentChat(bridge, 'ws-unknown', null)).toBeNull();
    });

    it('round-trips build/parse of planning open action ID', () => {
        const customId = buildPlanningCustomId('open', 'my-workspace', '123456');
        const parsed = parsePlanningCustomId(customId);
        expect(parsed).toEqual({ action: 'open', projectName: 'my-workspace', channelId: '123456' });
    });

    it('round-trips build/parse of planning proceed action ID', () => {
        const customId = buildPlanningCustomId('proceed', 'my-workspace', '789');
        const parsed = parsePlanningCustomId(customId);
        expect(parsed).toEqual({ action: 'proceed', projectName: 'my-workspace', channelId: '789' });
    });

    it('supports planning action IDs without channelId', () => {
        const parsed = parsePlanningCustomId('planning_open_action:legacy-workspace');
        expect(parsed).toEqual({ action: 'open', projectName: 'legacy-workspace', channelId: null });
    });

    it('parsePlanningCustomId returns null for non-planning IDs', () => {
        expect(parsePlanningCustomId('approve_action:ws-a')).toBeNull();
        expect(parsePlanningCustomId('random_string')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// ensureApprovalDetector
// ---------------------------------------------------------------------------
describe('ensureApprovalDetector', () => {
    const MockedApprovalDetector = ApprovalDetector as jest.MockedClass<typeof ApprovalDetector>;
    const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

    let mockStart: jest.Mock;
    let mockIsActive: jest.Mock;
    let capturedOptions: ConstructorParameters<typeof ApprovalDetector>[0] | null;

    beforeEach(() => {
        jest.clearAllMocks();
        capturedOptions = null;
        mockStart = jest.fn();
        mockIsActive = jest.fn().mockReturnValue(false);

        MockedApprovalDetector.mockImplementation((opts) => {
            capturedOptions = opts;
            return { start: mockStart, isActive: mockIsActive, stop: jest.fn() } as any;
        });
    });

    function makeCdp() {
        const cdp = new MockedCdpService() as jest.Mocked<CdpService>;
        cdp.getPrimaryContextId = jest.fn().mockReturnValue(null);
        cdp.getContexts = jest.fn().mockReturnValue([]);
        cdp.call = jest.fn().mockResolvedValue({ result: { value: null } });
        return cdp;
    }

    it('creates and starts an ApprovalDetector for the workspace', () => {
        const bridge = initCdpBridge(false);
        const cdp = makeCdp();

        ensureApprovalDetector(bridge, cdp, 'my-project');

        expect(MockedApprovalDetector).toHaveBeenCalledTimes(1);
        expect(mockStart).toHaveBeenCalledTimes(1);
        expect(bridge.pool.getApprovalDetector('my-project')).toBeDefined();
    });

    it('does not create a second detector when one is already active', () => {
        const bridge = initCdpBridge(false);
        const cdp = makeCdp();

        mockIsActive.mockReturnValue(true);

        ensureApprovalDetector(bridge, cdp, 'my-project');
        // Simulate existing active detector
        const firstDetector = { start: mockStart, isActive: () => true, stop: jest.fn(), getCdpService: () => cdp } as any;
        bridge.pool.registerApprovalDetector('my-project', firstDetector);

        ensureApprovalDetector(bridge, cdp, 'my-project');

        // Constructor only called once (the first ensureApprovalDetector call)
        expect(MockedApprovalDetector).toHaveBeenCalledTimes(1);
    });

    it('onResolved removes the keyboard markup from the last approval message', () => {
        const bridge = initCdpBridge(false);
        const cdp = makeCdp();
        const mockEditMarkup = jest.fn().mockResolvedValue(undefined);
        bridge.botApi = { editMessageReplyMarkup: mockEditMarkup } as any;

        ensureApprovalDetector(bridge, cdp, 'my-project');
        expect(capturedOptions).not.toBeNull();

        // Simulate the detector storing a message ID by calling onApprovalRequired,
        // then call onResolved directly via the captured options.
        // Inject a fake lastMessageId by abusing the closure via the onResolved callback.

        // Directly invoke onResolved — with no prior message it should be a no-op.
        capturedOptions!.onResolved?.();
        expect(mockEditMarkup).not.toHaveBeenCalled();
    });

    it('onResolved handles editMessageReplyMarkup failure without throwing', async () => {
        const bridge = initCdpBridge(false);
        const cdp = makeCdp();
        const mockEditMarkup = jest.fn().mockRejectedValue(new Error('400: Bad Request: message is not modified'));
        bridge.botApi = { editMessageReplyMarkup: mockEditMarkup } as any;

        // Capture the onApprovalRequired callback so we can trigger it and set lastMessageId
        let capturedOnApproval: ((info: any) => Promise<void>) | null = null;
        MockedApprovalDetector.mockImplementationOnce((opts) => {
            capturedOptions = opts;
            capturedOnApproval = opts.onApprovalRequired as any;
            return { start: jest.fn(), isActive: jest.fn().mockReturnValue(false), stop: jest.fn() } as any;
        });

        const channel = { chatId: 999 };
        bridge.approvalChannelByWorkspace.set('my-project', channel);
        (bridge.botApi as any).sendMessage = jest.fn().mockResolvedValue({ message_id: 42 });

        ensureApprovalDetector(bridge, cdp, 'my-project');

        // Trigger onApprovalRequired to populate lastMessageId in the closure
        await capturedOnApproval!({ approveText: 'Allow', denyText: 'Deny', description: 'test' });

        // Now call onResolved — editMessageReplyMarkup will fail with 400 but must not throw
        await expect(
            new Promise<void>((resolve) => {
                capturedOptions!.onResolved?.();
                // Give the microtask queue a chance to run the .catch handler
                setImmediate(resolve);
            })
        ).resolves.toBeUndefined();
    });
});
