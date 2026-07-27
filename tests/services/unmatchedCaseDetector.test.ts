/**
 * Generic "no matching case" fallback detector — TDD tests
 *
 * Test strategy:
 *   - UnmatchedCaseDetector is the test target
 *   - Mock CdpService to simulate DOM with/without an "Other (write your answer)" option
 *   - Verify it only fires when isOtherDetectorActive() returns false
 *   - Verify it clicks Other, focuses free-text input, types the fallback reply,
 *     submits (Submit button, else Send, else Enter), and notifies via callback
 *   - Verify dedup (does not re-click the same trigger every poll)
 *   - Verify CDP error tolerance
 */
import { UnmatchedCaseDetector, UnmatchedCaseDetectorOptions, DEFAULT_UNMATCHED_CASE_REPLY } from '../../src/services/unmatchedCaseDetector';
import { CdpService } from '../../src/services/cdpService';

jest.mock('../../src/services/cdpService');
const MockedCdpService = CdpService as jest.MockedClass<typeof CdpService>;

describe('UnmatchedCaseDetector - generic "no matching case" fallback', () => {
    let detector: UnmatchedCaseDetector;
    let mockCdpService: jest.Mocked<CdpService>;

    beforeEach(() => {
        jest.useFakeTimers();
        mockCdpService = new MockedCdpService() as jest.Mocked<CdpService>;
        mockCdpService.getPrimaryContextId = jest.fn().mockReturnValue(42);
        jest.clearAllMocks();
    });

    afterEach(async () => {
        if (detector) {
            await detector.stop();
        }
        jest.useRealTimers();
    });

    function makeDetector(overrides: Partial<UnmatchedCaseDetectorOptions> = {}, onUnmatchedCaseHandled = jest.fn()): UnmatchedCaseDetector {
        return new UnmatchedCaseDetector({
            cdpService: mockCdpService,
            pollIntervalMs: 500,
            isOtherDetectorActive: () => false,
            onUnmatchedCaseHandled,
            ...overrides,
        });
    }

    it('does nothing while a specific detector (approval/planning/errorPopup) is active', async () => {
        const onUnmatchedCaseHandled = jest.fn();
        detector = makeDetector({ isOtherDetectorActive: () => true }, onUnmatchedCaseHandled);
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(mockCdpService.call).not.toHaveBeenCalled();
        expect(onUnmatchedCaseHandled).not.toHaveBeenCalled();
    });

    it('does not fire when no "Other (write your answer)" option is visible', async () => {
        const onUnmatchedCaseHandled = jest.fn();
        mockCdpService.call.mockResolvedValue({ result: { value: null } });

        detector = makeDetector({}, onUnmatchedCaseHandled);
        detector.start();

        await jest.advanceTimersByTimeAsync(500);

        expect(onUnmatchedCaseHandled).not.toHaveBeenCalled();
    });

    it('clicks Other, types the default fallback reply, submits, and notifies when detected', async () => {
        const onUnmatchedCaseHandled = jest.fn();

        mockCdpService.call
            // 1. DETECT_OTHER_OPTION_SCRIPT
            .mockResolvedValueOnce({ result: { value: { text: 'Other (write your answer)' } } })
            // 2. buildClickScript('Other (write your answer)')
            .mockResolvedValueOnce({ result: { value: { ok: true } } })
            // 3. FOCUS_FREE_TEXT_INPUT_SCRIPT
            .mockResolvedValueOnce({ result: { value: { ok: true } } })
            // 4. Input.insertText
            .mockResolvedValueOnce({})
            // 5. buildClickScript('Submit')
            .mockResolvedValueOnce({ result: { value: { ok: true } } });

        detector = makeDetector({}, onUnmatchedCaseHandled);
        detector.start();

        // The internal handleUnmatchedCase() flow has its own 200ms + 150ms
        // waits (fake-timer-controlled) beyond the poll tick itself.
        await jest.advanceTimersByTimeAsync(1000);

        expect(onUnmatchedCaseHandled).toHaveBeenCalledTimes(1);
        expect(onUnmatchedCaseHandled).toHaveBeenCalledWith({
            triggerText: 'Other (write your answer)',
            replyText: DEFAULT_UNMATCHED_CASE_REPLY,
        });

        // Verify the fallback text was actually typed in
        const insertTextCall = mockCdpService.call.mock.calls.find(([method]) => method === 'Input.insertText');
        expect(insertTextCall?.[1]).toEqual({ text: DEFAULT_UNMATCHED_CASE_REPLY });
    });

    it('falls back to Send button, then Enter, if Submit is not found', async () => {
        const onUnmatchedCaseHandled = jest.fn();

        mockCdpService.call
            .mockResolvedValueOnce({ result: { value: { text: 'Other (write your answer)' } } }) // detect
            .mockResolvedValueOnce({ result: { value: { ok: true } } }) // click Other
            .mockResolvedValueOnce({ result: { value: { ok: true } } }) // focus input
            .mockResolvedValueOnce({}) // insertText
            .mockResolvedValueOnce({ result: { value: { ok: false } } }) // Submit not found
            .mockResolvedValueOnce({ result: { value: { ok: false } } }) // Send not found
            .mockResolvedValueOnce({}) // keyDown Enter
            .mockResolvedValueOnce({}); // keyUp Enter

        detector = makeDetector({}, onUnmatchedCaseHandled);
        detector.start();

        await jest.advanceTimersByTimeAsync(1000);

        expect(onUnmatchedCaseHandled).toHaveBeenCalledTimes(1);
        const dispatchKeyCalls = mockCdpService.call.mock.calls.filter(([method]) => method === 'Input.dispatchKeyEvent');
        expect(dispatchKeyCalls.length).toBe(2); // keyDown + keyUp Enter
    });

    it('does not re-click the same "Other" trigger on every poll (dedup)', async () => {
        const onUnmatchedCaseHandled = jest.fn();

        mockCdpService.call.mockResolvedValue({ result: { value: { text: 'Other (write your answer)' } } });
        // First cycle succeeds fully via generic ok:true responses for subsequent calls too
        mockCdpService.call.mockImplementation(async (method: string) => {
            if (method === 'Runtime.evaluate') {
                return { result: { value: { text: 'Other (write your answer)', ok: true } } };
            }
            return {};
        });

        detector = makeDetector({}, onUnmatchedCaseHandled);
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        expect(onUnmatchedCaseHandled).toHaveBeenCalledTimes(1);
    });

    it('resets dedup state once the trigger disappears, allowing a future re-detection', async () => {
        const onUnmatchedCaseHandled = jest.fn();
        let call = 0;
        mockCdpService.call.mockImplementation(async (method: string) => {
            if (method === 'Runtime.evaluate') {
                call++;
                if (call === 1) return { result: { value: { text: 'Other (write your answer)' } } }; // detect #1
                if (call === 2) return { result: { value: { ok: true } } }; // click
                if (call === 3) return { result: { value: { ok: true } } }; // focus
                if (call === 4) return { result: { value: { ok: true } } }; // submit
                if (call === 5) return { result: { value: null } }; // detect: gone
                if (call === 6) return { result: { value: { text: 'Other (write your answer)' } } }; // detect #2 (new dialog)
                if (call === 7) return { result: { value: { ok: true } } }; // click
                if (call === 8) return { result: { value: { ok: true } } }; // focus
                if (call === 9) return { result: { value: { ok: true } } }; // submit
            }
            return {};
        });

        detector = makeDetector({}, onUnmatchedCaseHandled);
        detector.start();

        await jest.advanceTimersByTimeAsync(1000); // handled #1
        await jest.advanceTimersByTimeAsync(500); // gone -> reset
        await jest.advanceTimersByTimeAsync(1000); // handled #2

        expect(onUnmatchedCaseHandled).toHaveBeenCalledTimes(2);
    });

    it('tolerates CDP errors and keeps polling', async () => {
        const onUnmatchedCaseHandled = jest.fn();
        mockCdpService.call.mockRejectedValue(new Error('boom'));

        detector = makeDetector({}, onUnmatchedCaseHandled);
        detector.start();

        await jest.advanceTimersByTimeAsync(500);
        await jest.advanceTimersByTimeAsync(500);

        expect(onUnmatchedCaseHandled).not.toHaveBeenCalled();
    });

    it('supports a custom replyText override', async () => {
        const onUnmatchedCaseHandled = jest.fn();
        mockCdpService.call
            .mockResolvedValueOnce({ result: { value: { text: 'Other (write your answer)' } } })
            .mockResolvedValueOnce({ result: { value: { ok: true } } })
            .mockResolvedValueOnce({ result: { value: { ok: true } } })
            .mockResolvedValueOnce({})
            .mockResolvedValueOnce({ result: { value: { ok: true } } });

        detector = makeDetector({ replyText: 'custom reply' }, onUnmatchedCaseHandled);
        detector.start();

        await jest.advanceTimersByTimeAsync(1000);

        expect(onUnmatchedCaseHandled).toHaveBeenCalledWith({
            triggerText: 'Other (write your answer)',
            replyText: 'custom reply',
        });
    });

    it('isActive() reflects start/stop lifecycle', async () => {
        detector = makeDetector();
        expect(detector.isActive()).toBe(false);
        detector.start();
        expect(detector.isActive()).toBe(true);
        await detector.stop();
        expect(detector.isActive()).toBe(false);
    });

    it('getCdpService() returns the bound CdpService instance', () => {
        detector = makeDetector();
        expect(detector.getCdpService()).toBe(mockCdpService);
    });
});
