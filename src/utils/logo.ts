import { execSync } from 'child_process';

function getGitInfo(): { hash: string; subject: string; date: string } {
    try {
        const hash    = execSync('git rev-parse --short HEAD',          { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
        const subject = execSync('git log -1 --format=%s',              { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
        const date    = execSync('git log -1 --format=%cd --date=short', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim();
        return { hash, subject, date };
    } catch {
        return { hash: 'unknown', subject: 'unknown', date: '' };
    }
}

const { hash, subject, date } = getGitInfo();
const commitLine = `     commit ${hash}  ${date}`;
const subjectLine = `     ${subject}`;

export const LOGO = `
            ,_,
           (O,O)
           (   )
           -"-"-

     ~ Booting... Remoat ~
${commitLine}
${subjectLine}
`;
