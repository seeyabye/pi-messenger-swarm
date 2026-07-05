import { MEMORY_CHANNEL_ID, deleteChannel, displayChannelLabel, getChannel, normalizeChannelId, readChannelEventLines, } from '../../channel.js';
import { getAgentsInChannel } from '../../store/agents.js';
import { invalidateFeedCache } from '../../feed/index.js';
import { pruneOrphanedSessionChannels } from '../../store/channel-gc.js';
import { notRegisteredError, result } from '../result.js';
/**
 * Remove orphaned session channels (header-only, no live agents, dead
 * session). Named channels and session channels with history are preserved.
 * `dryRun` lists what would be removed without deleting.
 */
export function executeChannelPrune(state, dirs, cwd, dryRun = false) {
    if (!state.registered)
        return notRegisteredError();
    const { deleted, kept } = pruneOrphanedSessionChannels(state, dirs, cwd, {
        dryRun,
        currentSessionId: state.contextSessionId,
    });
    if (deleted.length === 0) {
        return result('No orphaned session channels found.', {
            mode: 'channel.prune',
            dryRun,
            deleted: [],
            kept,
        });
    }
    const verb = dryRun ? 'would remove' : 'removed';
    const lines = [
        `${dryRun ? '[dry-run] ' : ''}${verb} ${deleted.length} orphaned session channel${deleted.length === 1 ? '' : 's'}:`,
        ...deleted.map((id) => `  - ${displayChannelLabel(id)}`),
    ];
    if (kept.length > 0) {
        lines.push(`Kept ${kept.length} session channel${kept.length === 1 ? '' : 's'} (active or with history).`);
    }
    return result(lines.join('\n'), {
        mode: 'channel.prune',
        dryRun,
        deleted,
        kept,
    });
}
/**
 * Delete a specific channel by id. Refuses #memory, channels with live agents
 * joined, and channels with feed history unless --force is given. Use this to
 * retire abandoned named channels (e.g. per-task channels) that have real
 * content.
 */
export function executeChannelDelete(params, state, dirs, cwd) {
    if (!state.registered)
        return notRegisteredError();
    const id = params.channel ? normalizeChannelId(params.channel) : '';
    if (!id) {
        return result('Error: channel required for channel.delete (e.g. --channel pr35-regression).', {
            mode: 'channel.delete',
            error: 'missing_channel',
        });
    }
    if (id === MEMORY_CHANNEL_ID) {
        return result(`Error: ${displayChannelLabel(id)} is a protected channel and cannot be deleted.`, { mode: 'channel.delete', error: 'protected', channel: id });
    }
    const record = getChannel(dirs, id);
    if (!record) {
        return result(`Error: channel ${displayChannelLabel(id)} not found.`, {
            mode: 'channel.delete',
            error: 'not_found',
            channel: id,
        });
    }
    // Refuse if the current agent is joined to this channel. getAgentsInChannel
    // excludes the current agent, so check membership explicitly — otherwise
    // deleting would leave state.currentChannel / joinedChannels dangling.
    if (state.joinedChannels.includes(id)) {
        return result(`Error: you are currently joined to ${displayChannelLabel(id)}. Switch channels first.`, { mode: 'channel.delete', error: 'self_joined', channel: id });
    }
    // Refuse if a live agent is currently joined.
    const joined = getAgentsInChannel(state, dirs, id);
    if (joined.length > 0) {
        const names = joined.map((a) => a.name).join(', ');
        return result(`Error: cannot delete ${displayChannelLabel(id)} — ${joined.length} agent${joined.length === 1 ? '' : 's'} joined: ${names}. Have them switch channels first.`, { mode: 'channel.delete', error: 'agents_joined', channel: id, agents: names });
    }
    // Refuse to delete a channel with history unless --force.
    const eventCount = readChannelEventLines(dirs, id).length;
    if (eventCount > 0 && !params.force) {
        return result(`Error: ${displayChannelLabel(id)} has ${eventCount} feed event${eventCount === 1 ? '' : 's'}. Re-run with --force to delete it anyway.`, { mode: 'channel.delete', error: 'has_history', channel: id, eventCount });
    }
    deleteChannel(dirs, id);
    invalidateFeedCache(cwd, id);
    return result(`✅ Deleted channel ${displayChannelLabel(id)} (${record.type}).`, {
        mode: 'channel.delete',
        channel: id,
        type: record.type,
        eventCount,
    });
}
