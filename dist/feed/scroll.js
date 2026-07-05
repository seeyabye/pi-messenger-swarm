/**
 * Pi Messenger - Feed Scroll Logic
 *
 * This module provides line-based scroll behavior for the activity feed.
 * The scroll position is tracked as an offset into *rendered lines*, not event indices.
 * This ensures j/k scroll by screen lines, and the view stays locked to what the user
 * was reading when new events arrive.
 */
import { renderFeedSection } from '../overlay/render-exports.js';
import { isAtBottom as isAtBottomCore, calculateVisibleRangeFromLines, } from './scroll-core.js';
// Re-export core functions and types
export { scrollUp, scrollDown, jumpToBottom, jumpToTop, maintainScrollOnNewEvents, calculateWindowForOlderLoad, initializeScrollState, calculateVisibleRangeFromLines, } from './scroll-core.js';
// Re-export isAtBottom with the same signature for compatibility
export function isAtBottom(lineScrollOffset, totalRenderedLines, feedHeight) {
    return isAtBottomCore(lineScrollOffset, totalRenderedLines, feedHeight);
}
let renderedLinesCache = null;
let visibleRangeCache = null;
/**
 * Calculate all rendered lines for the loaded events.
 * Returns the array of rendered lines and a map from screen line index to event index.
 */
export function calculateRenderedLines(events, theme, width, lastSeenTs, expanded) {
    if (renderedLinesCache &&
        renderedLinesCache.events === events &&
        renderedLinesCache.theme === theme &&
        renderedLinesCache.width === width &&
        renderedLinesCache.lastSeenTs === lastSeenTs &&
        renderedLinesCache.expanded === expanded) {
        return renderedLinesCache.result;
    }
    const lines = renderFeedSection(theme, events, width, lastSeenTs, expanded);
    // Build a map from each screen line to which event it belongs to
    const eventIndexMap = [];
    let currentLine = 0;
    for (let i = 0; i < events.length; i++) {
        // Render just this event to count its lines
        const eventLines = renderFeedSection(theme, [events[i]], width, lastSeenTs, expanded);
        for (let j = 0; j < eventLines.length; j++) {
            eventIndexMap[currentLine + j] = i;
        }
        currentLine += eventLines.length;
    }
    const result = { lines, eventIndexMap };
    renderedLinesCache = {
        events,
        theme,
        width,
        lastSeenTs,
        expanded,
        result,
    };
    return result;
}
/**
 * Calculate which events to show based on line-based scroll offset.
 *
 * lineScrollOffset: number of lines from bottom (0 = at bottom)
 * feedHeight: number of lines visible in viewport
 */
export function calculateVisibleRange(loadedEvents, theme, width, lastSeenTs, expanded, lineScrollOffset, feedHeight, windowStart, totalLines) {
    if (visibleRangeCache &&
        visibleRangeCache.loadedEvents === loadedEvents &&
        visibleRangeCache.theme === theme &&
        visibleRangeCache.width === width &&
        visibleRangeCache.lastSeenTs === lastSeenTs &&
        visibleRangeCache.expanded === expanded &&
        visibleRangeCache.lineScrollOffset === lineScrollOffset &&
        visibleRangeCache.feedHeight === feedHeight &&
        visibleRangeCache.windowStart === windowStart &&
        visibleRangeCache.totalLines === totalLines) {
        return visibleRangeCache.result;
    }
    if (loadedEvents.length === 0 || feedHeight <= 0) {
        return {
            events: [],
            arrayStart: 0,
            arrayEnd: 0,
            visibleLines: [],
            totalRenderedLines: 0,
            lineScrollOffset: 0,
            needsOlderLoad: false,
            needsNewerLoad: false,
            firstVisibleEventIndex: 0,
            lastVisibleEventIndex: 0,
        };
    }
    // Calculate all rendered lines
    const { lines, eventIndexMap } = calculateRenderedLines(loadedEvents, theme, width, lastSeenTs, expanded);
    if (lines.length === 0) {
        return {
            events: [],
            arrayStart: 0,
            arrayEnd: 0,
            visibleLines: [],
            totalRenderedLines: 0,
            lineScrollOffset: 0,
            needsOlderLoad: false,
            needsNewerLoad: false,
            firstVisibleEventIndex: 0,
            lastVisibleEventIndex: 0,
        };
    }
    // Use the core function to calculate visible range
    const rangeResult = calculateVisibleRangeFromLines(lines, lineScrollOffset, feedHeight, windowStart, totalLines);
    // Map back to event indices for the visible range
    const lineStart = lines.length - rangeResult.lineScrollOffset - rangeResult.visibleLines.length;
    const lineEnd = lineStart + rangeResult.visibleLines.length;
    const firstVisibleEventIndex = eventIndexMap[Math.max(0, lineStart)] ?? 0;
    const lastVisibleEventIndex = eventIndexMap[Math.min(lineEnd - 1, lines.length - 1)] ?? loadedEvents.length - 1;
    const result = {
        events: loadedEvents.slice(firstVisibleEventIndex, lastVisibleEventIndex + 1),
        arrayStart: firstVisibleEventIndex,
        arrayEnd: lastVisibleEventIndex + 1,
        visibleLines: rangeResult.visibleLines,
        totalRenderedLines: lines.length,
        lineScrollOffset: rangeResult.lineScrollOffset,
        needsOlderLoad: rangeResult.needsOlderLoad,
        needsNewerLoad: rangeResult.needsNewerLoad,
        firstVisibleEventIndex,
        lastVisibleEventIndex,
    };
    visibleRangeCache = {
        loadedEvents,
        theme,
        width,
        lastSeenTs,
        expanded,
        lineScrollOffset,
        feedHeight,
        windowStart,
        totalLines,
        result,
    };
    return result;
}
