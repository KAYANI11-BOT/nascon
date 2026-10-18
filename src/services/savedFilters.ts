import type {SavedFilter,SavedFilterInput} from '@/types/domain';
import {createUnavailableCrmService} from './crm';
// Proposed (not in the approved schema): saved opportunity filters, scoped to the workspace and to the signed-in user.
// A server boundary must set workspace_id and user_id from the session, never from the client.
export const savedFilterService=createUnavailableCrmService<SavedFilter,SavedFilterInput>('saved filter');
