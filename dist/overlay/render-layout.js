/**
 * Overlay list-mode layout calculations.
 *
 * Extracted from the MessengerOverlay render() method so the main component
 * stays focused on lifecycle, caching, and assembly.
 */
import { renderWorkersSection, renderTaskList, renderSwarmList, renderAgentsRow, renderEmptyState, } from './render-exports.js';
import { calculateVisibleRange, calculateWindowForOlderLoad } from '../feed/scroll.js';
import { readFeedEventsByRange } from '../feed/index.js';
const FEED_LOAD_CHUNK = 100;
const FEED_WINDOW_SIZE = 200;
/**
 * Calculate the list-mode content lines, adjusting heights and loading
 * older feed events as needed. Returns the content lines ready for
 * insertion between the chrome header and the legend/footer.
 */
export function calculateListLayout(params) {
    const { theme, cwd, sectionW, innerW, contentHeight, termRows, state, dirs, stuckThresholdMs, viewState, liveWorkers, tasks, spawned, mainHeight, totalFeedLines, prevTs, currentChannel, feedWindowStart, feedWindowEnd, } = params;
    let { feedHeight } = params;
    const sectionSeparator = theme.fg('dim', '─'.repeat(sectionW));
    const agentsLine = renderAgentsRow(cwd, sectionW, state, dirs, stuckThresholdMs, liveWorkers);
    // Adjust heights based on list panel content (may increase feedHeight)
    const isListPanel = viewState.mainView === 'swarm' || tasks.length > 0;
    if (isListPanel) {
        const listContentHeight = viewState.mainView === 'swarm' ? Math.max(2, spawned.length) : Math.max(2, tasks.length);
        if (listContentHeight < mainHeight) {
            const surplus = mainHeight - listContentHeight;
            feedHeight += surplus;
        }
    }
    const adjustedMainHeight = isListPanel
        ? Math.min(mainHeight, viewState.mainView === 'swarm' ? Math.max(2, spawned.length) : Math.max(2, tasks.length))
        : mainHeight;
    const calculateFeedLinesForHeight = (viewportHeight) => {
        if (viewportHeight <= 0)
            return [];
        let rangeResult = calculateVisibleRange(viewState.feedLoadedEvents, theme, sectionW, prevTs, viewState.expandFeedMessages, viewState.feedLineScrollOffset, viewportHeight, viewState.feedWindowStart, totalFeedLines);
        viewState.wasAtBottom = rangeResult.lineScrollOffset === 0;
        viewState.feedLineScrollOffset = rangeResult.lineScrollOffset;
        if (rangeResult.needsOlderLoad && viewState.feedWindowStart > 0) {
            const { newWindowStart, newWindowEnd } = calculateWindowForOlderLoad(viewState.feedWindowStart, viewState.feedWindowEnd, FEED_LOAD_CHUNK, FEED_WINDOW_SIZE, totalFeedLines);
            const olderEvents = readFeedEventsByRange(cwd, newWindowStart, viewState.feedWindowStart, currentChannel);
            if (olderEvents.length > 0) {
                viewState.feedLoadedEvents = [...olderEvents, ...viewState.feedLoadedEvents];
                viewState.feedWindowStart = newWindowStart;
                viewState.feedWindowEnd = newWindowEnd;
                rangeResult = calculateVisibleRange(viewState.feedLoadedEvents, theme, sectionW, prevTs, viewState.expandFeedMessages, viewState.feedLineScrollOffset, viewportHeight, viewState.feedWindowStart, totalFeedLines);
                viewState.wasAtBottom = rangeResult.lineScrollOffset === 0;
                viewState.feedLineScrollOffset = rangeResult.lineScrollOffset;
            }
        }
        return rangeResult.visibleLines;
    };
    let mainLines;
    if (viewState.mainView === 'swarm') {
        mainLines = renderSwarmList(theme, spawned, sectionW, adjustedMainHeight, viewState);
    }
    else if (tasks.length === 0) {
        mainLines = renderEmptyState(theme, cwd, sectionW, adjustedMainHeight, currentChannel);
    }
    else {
        mainLines = renderTaskList(theme, cwd, sectionW, adjustedMainHeight, viewState, currentChannel, liveWorkers, tasks);
    }
    let feedLines = calculateFeedLinesForHeight(feedHeight);
    // Calculate workers after feed lines to ensure consistency
    const workersLimit = termRows <= 26 ? 2 : 5;
    let workerLines = renderWorkersSection(theme, cwd, sectionW, workersLimit, liveWorkers);
    const agentsHeight = 2;
    const workersHeight = () => (workerLines.length > 0 ? workerLines.length + 1 : 0);
    while (workerLines.length > 0 &&
        workersHeight() +
            mainLines.length +
            (feedLines.length > 0 ? feedLines.length + 1 : 0) +
            agentsHeight >
            contentHeight) {
        workerLines = workerLines.slice(0, workerLines.length - 1);
    }
    const maxFeedHeight = totalFeedLines > 0
        ? Math.max(0, contentHeight - agentsHeight - workersHeight() - mainLines.length - 1)
        : 0;
    if (maxFeedHeight > feedLines.length) {
        feedLines = calculateFeedLinesForHeight(maxFeedHeight);
    }
    const contentLines = [];
    contentLines.push(agentsLine);
    contentLines.push(sectionSeparator);
    if (workerLines.length > 0) {
        contentLines.push(...workerLines);
        contentLines.push(sectionSeparator);
    }
    contentLines.push(...mainLines);
    if (feedLines.length > 0) {
        contentLines.push(sectionSeparator);
        contentLines.push(...feedLines);
    }
    if (contentLines.length > contentHeight) {
        contentLines.length = contentHeight;
    }
    while (contentLines.length < contentHeight) {
        contentLines.push('');
    }
    return { contentLines, sectionSeparator, workerLines };
}
