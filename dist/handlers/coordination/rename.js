import * as store from '../../store.js';
import { notRegisteredError, result } from '../result.js';
export function executeRename(state, dirs, ctx, newName, _deliverMessage, _updateStatus) {
    if (!state.registered) {
        return notRegisteredError();
    }
    const result_data = store.renameAgent(state, dirs, ctx, newName, () => { });
    if (result_data.success === false) {
        return result(`Error: ${result_data.error}`, { mode: 'rename', error: result_data.error });
    }
    store.updateRegistration(state, dirs, ctx);
    return result(`Renamed from ${result_data.oldName} to ${result_data.newName}`, {
        mode: 'rename',
        oldName: result_data.oldName,
        newName: result_data.newName,
    });
}
