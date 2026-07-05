import { truncateToWidth } from '@earendil-works/pi-tui';
import { coloredAgentName } from '../lib.js';
import { formatFeedLine as sharedFormatFeedLine, sanitizeFeedEvent, } from '../feed/index.js';
const DIM_EVENTS = new Set(['join', 'leave', 'reserve', 'release']);
export function renderFeedSection(theme, events, width, lastSeenTs, expanded = false) {
    if (events.length === 0)
        return [];
    const lines = [];
    let lastWasMessage = false;
    for (const event of events) {
        const sanitized = sanitizeFeedEvent(event);
        const isNew = lastSeenTs === null || sanitized.ts > lastSeenTs;
        const isMessage = sanitized.type === 'message';
        if (lines.length > 0 && isMessage !== lastWasMessage) {
            lines.push(theme.fg('dim', '  ·'));
        }
        if (isMessage) {
            lines.push(...renderMessageLines(theme, sanitized, width, expanded));
        }
        else {
            const formatted = sharedFormatFeedLine(sanitized);
            const dimmed = DIM_EVENTS.has(sanitized.type) || !isNew;
            lines.push(truncateToWidth(dimmed ? theme.fg('dim', formatted) : formatted, width));
        }
        lastWasMessage = isMessage;
    }
    return lines;
}
function wrapText(text, maxWidth) {
    if (text.length <= maxWidth)
        return [text];
    const lines = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= maxWidth) {
            lines.push(remaining);
            break;
        }
        let breakAt = remaining.lastIndexOf(' ', maxWidth);
        if (breakAt <= 0)
            breakAt = maxWidth;
        lines.push(remaining.slice(0, breakAt));
        remaining = remaining.slice(breakAt).trimStart();
    }
    return lines;
}
function renderMarkdownLine(line, theme) {
    let rendered = line;
    rendered = rendered.replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[22m');
    rendered = rendered.replace(/__(.+?)__/g, '\x1b[1m$1\x1b[22m');
    rendered = rendered.replace(/\*(.+?)\*/g, '\x1b[3m$1\x1b[23m');
    rendered = rendered.replace(/_(.+?)_/g, '\x1b[3m$1\x1b[23m');
    rendered = rendered.replace(/`(.+?)`/g, (_, text) => theme.fg('accent', text));
    return rendered;
}
function renderMessageLines(theme, event, width, expanded = false) {
    const time = new Date(event.ts).toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
    const agentStyled = coloredAgentName(event.agent);
    const rawPreview = event.preview?.trim() ?? '';
    const direction = event.target ? `→ ${event.target}` : '✦';
    const singleLen = time.length +
        1 +
        event.agent.length +
        1 +
        (event.target ? 2 + event.target.length : 1) +
        (rawPreview ? 1 + rawPreview.length : 0);
    if (singleLen <= width && rawPreview) {
        return [
            truncateToWidth(`${time} ${agentStyled} ${theme.fg('accent', direction)} ${rawPreview}`, width),
        ];
    }
    const header = `${time} ${agentStyled} ${theme.fg('accent', direction)}`;
    if (!rawPreview)
        return [truncateToWidth(header, width)];
    const indent = '      ';
    const maxBody = width - indent.length;
    let allLines;
    if (expanded) {
        const paragraphs = rawPreview.split('\n');
        allLines = [];
        for (const para of paragraphs) {
            if (para.trim() === '') {
                allLines.push('');
            }
            else {
                const wrapped = wrapText(para, maxBody);
                for (const line of wrapped) {
                    allLines.push(renderMarkdownLine(line, theme));
                }
            }
        }
    }
    else {
        allLines = wrapText(rawPreview.replace(/\n/g, ' '), maxBody);
    }
    const result = [truncateToWidth(header, width)];
    const maxLines = expanded ? allLines.length : Math.min(3, allLines.length);
    for (let i = 0; i < maxLines; i++) {
        result.push(truncateToWidth(`${indent}${allLines[i]}`, width));
    }
    if (!expanded && allLines.length > 3) {
        result.push(truncateToWidth(`${indent}...`, width));
    }
    return result;
}
