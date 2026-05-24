import {
    buildProjectListUI,
    isProjectSelectId,
    parseProjectPageId,
    PROJECT_PAGE_PREFIX,
    PROJECT_SELECT_ID,
    WORKSPACE_SELECT_ID,
    ITEMS_PER_PAGE,
    NEW_PROJECT_BTN,
    validateProjectName,
} from '../../src/ui/projectListUi';
import { InlineKeyboard } from 'grammy';

describe('projectListUi', () => {
    describe('parseProjectPageId', () => {
        it('parses a valid page button customId', () => {
            expect(parseProjectPageId('project_page:0')).toBe(0);
            expect(parseProjectPageId('project_page:3')).toBe(3);
            expect(parseProjectPageId('project_page:99')).toBe(99);
        });

        it('returns NaN for non-matching customId', () => {
            expect(parseProjectPageId('other_id')).toBeNaN();
            expect(parseProjectPageId('project_page')).toBeNaN();
            expect(parseProjectPageId('')).toBeNaN();
        });

        it('returns NaN for malformed page number', () => {
            expect(parseProjectPageId('project_page:abc')).toBeNaN();
        });
    });

    describe('isProjectSelectId', () => {
        it('matches project_select', () => {
            expect(isProjectSelectId(PROJECT_SELECT_ID)).toBe(true);
        });

        it('matches workspace_select', () => {
            expect(isProjectSelectId(WORKSPACE_SELECT_ID)).toBe(true);
        });

        it('matches project_select with suffix', () => {
            expect(isProjectSelectId('project_select:my-project')).toBe(true);
        });

        it('does not match unrelated customIds', () => {
            expect(isProjectSelectId('mode_select')).toBe(false);
            expect(isProjectSelectId('project_page:0')).toBe(false);
            expect(isProjectSelectId('')).toBe(false);
        });
    });

    describe('buildProjectListUI', () => {
        const makeWorkspaces = (count: number): string[] =>
            Array.from({ length: count }, (_, i) => `project-${String(i + 1).padStart(3, '0')}`);

        it('returns empty keyboard for zero workspaces', () => {
            const { text, keyboard } = buildProjectListUI([], 0);

            expect(text).toContain('No projects found');
            expect(keyboard).toBeInstanceOf(InlineKeyboard);
        });

        it('shows buttons for workspaces on a single page', () => {
            const workspaces = makeWorkspaces(5);
            const { text, keyboard } = buildProjectListUI(workspaces, 0);

            expect(text).toContain('Projects');
            for (const ws of workspaces) {
                expect(text).toContain(ws);
            }
            expect(keyboard).toBeInstanceOf(InlineKeyboard);
        });

        it('does not add page info for single-page results', () => {
            const workspaces = makeWorkspaces(5);
            const { text } = buildProjectListUI(workspaces, 0);

            expect(text).not.toContain('Page');
        });

        it('shows page info for multi-page workspaces', () => {
            const workspaces = makeWorkspaces(15);
            const { text } = buildProjectListUI(workspaces, 0);

            expect(text).toContain('Page 1 / 2');
            expect(text).toContain('15 projects total');
        });

        it('second page shows remaining items', () => {
            const workspaces = makeWorkspaces(15);
            const { text } = buildProjectListUI(workspaces, 1);

            expect(text).toContain('Page 2 / 2');
            expect(text).toContain(workspaces[10]);
        });

        it('clamps out-of-range page to the last valid page', () => {
            const workspaces = makeWorkspaces(15);
            const { text } = buildProjectListUI(workspaces, 100);

            expect(text).toContain('Page 2 / 2');
        });

        it('clamps negative page to 0', () => {
            const workspaces = makeWorkspaces(15);
            const { text } = buildProjectListUI(workspaces, -5);

            expect(text).toContain('Page 1 / 2');
        });

        it('handles exactly ITEMS_PER_PAGE workspaces (single page)', () => {
            const workspaces = makeWorkspaces(ITEMS_PER_PAGE);
            const { text } = buildProjectListUI(workspaces, 0);

            expect(text).not.toContain('Page');
        });

        it('always includes the New Project button when list is empty', () => {
            const { keyboard } = buildProjectListUI([], 0);
            const flat = keyboard.inline_keyboard.flat();
            expect(flat.some(btn => (btn as any).callback_data === NEW_PROJECT_BTN)).toBe(true);
        });

        it('always includes the New Project button for non-empty lists', () => {
            const { keyboard } = buildProjectListUI(makeWorkspaces(3), 0);
            const flat = keyboard.inline_keyboard.flat();
            expect(flat.some(btn => (btn as any).callback_data === NEW_PROJECT_BTN)).toBe(true);
        });
    });

    describe('validateProjectName', () => {
        it('accepts a normal project name', () => {
            expect(validateProjectName('MyProject')).toEqual({ ok: true });
        });

        it('accepts names with dashes and underscores', () => {
            expect(validateProjectName('my-app_v2')).toEqual({ ok: true });
        });

        it('rejects an empty string', () => {
            const result = validateProjectName('');
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toContain('empty');
        });

        it('rejects a whitespace-only string', () => {
            const result = validateProjectName('   ');
            expect(result.ok).toBe(false);
        });

        it('rejects names with path separator /', () => {
            const result = validateProjectName('foo/bar');
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toContain('invalid characters');
        });

        it('rejects names with path separator \\', () => {
            const result = validateProjectName('foo\\bar');
            expect(result.ok).toBe(false);
        });

        it('rejects names with Windows reserved characters', () => {
            for (const ch of [':', '*', '?', '"', '<', '>', '|']) {
                const result = validateProjectName(`bad${ch}name`);
                expect(result.ok).toBe(false);
            }
        });

        it('rejects names starting with a dot', () => {
            const result = validateProjectName('.hidden');
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toContain('dot');
        });

        it('rejects names longer than 100 characters', () => {
            const result = validateProjectName('a'.repeat(101));
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.reason).toContain('long');
        });

        it('accepts names exactly 100 characters long', () => {
            expect(validateProjectName('a'.repeat(100))).toEqual({ ok: true });
        });
    });
});
