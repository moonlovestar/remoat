import { CdpService } from '../../src/services/cdpService';

/**
 * Unit tests for CdpService.waitForUiReady().
 *
 * We spy on the internal `call()` method to avoid needing a real WebSocket server.
 */
describe('CdpService.waitForUiReady()', () => {
    let service: CdpService;

    beforeEach(() => {
        service = new CdpService({ portsToScan: [19299], maxReconnectAttempts: 0 });
        // Mark as connected so guards inside injectMessage don't short-circuit
        (service as any).isConnectedFlag = true;
        (service as any).ws = {}; // non-null sentinel
    });

    afterEach(async () => {
        // Reset to avoid timer leaks
        (service as any).isConnectedFlag = false;
        (service as any).ws = null;
    });

    it('returns true immediately when the chat input is already present', async () => {
        jest.spyOn(service as any, 'call').mockResolvedValueOnce({
            result: { value: { ready: true, reason: 'chat-input-found' } },
        });

        const result = await service.waitForUiReady(5_000, 100);
        expect(result).toBe(true);
    });

    it('returns true after polling past an auth screen', async () => {
        const callSpy = jest.spyOn(service as any, 'call')
            // First two polls: auth screen visible
            .mockResolvedValueOnce({ result: { value: { ready: false, reason: 'auth-screen' } } })
            .mockResolvedValueOnce({ result: { value: { ready: false, reason: 'auth-screen' } } })
            // Third poll: UI ready
            .mockResolvedValueOnce({ result: { value: { ready: true, reason: 'chat-input-found' } } });

        const result = await service.waitForUiReady(10_000, 50);
        expect(result).toBe(true);
        expect(callSpy).toHaveBeenCalledTimes(3);
    });

    it('returns true after polling past a "no-input-yet" state', async () => {
        jest.spyOn(service as any, 'call')
            .mockResolvedValueOnce({ result: { value: { ready: false, reason: 'no-input-yet' } } })
            .mockResolvedValueOnce({ result: { value: { ready: true, reason: 'chat-input-found' } } });

        const result = await service.waitForUiReady(10_000, 50);
        expect(result).toBe(true);
    });

    it('returns false when the UI never becomes ready before the timeout', async () => {
        jest.spyOn(service as any, 'call').mockResolvedValue({
            result: { value: { ready: false, reason: 'auth-screen' } },
        });

        // Use a very short timeout and interval for fast test execution
        const result = await service.waitForUiReady(150, 50);
        expect(result).toBe(false);
    });

    it('keeps polling when call() throws (WebSocket not settled)', async () => {
        jest.spyOn(service as any, 'call')
            // First poll: throws (simulates unstable WebSocket)
            .mockRejectedValueOnce(new Error('WebSocket not connected'))
            // Second poll: returns ready
            .mockResolvedValueOnce({ result: { value: { ready: true, reason: 'chat-input-found' } } });

        const result = await service.waitForUiReady(10_000, 50);
        expect(result).toBe(true);
    });
});
