export * from './types.js';
export * from './errors.js';
export {
  deleteSpace, createSpace, setSpaceName, slugForSpace,
  type DeleteSpaceResult, type CreateSpaceResult, type SetSpaceNameResult,
} from './spaces.js';
export { parseCapture, type Capture, type CaptureOptions } from './capture.js';
export {
  findTimeInText, resolveCaptureTime,
  type FoundTime, type ResolveTimeOptions,
} from './capture-time.js';
export {
  listSpaces, getInboxSpace, resolveSpaceForChannel, findSpaceByQuery,
} from './spaces.js';
export {
  createTask, getTask, completeTask, reopenTask, moveTask, updateTaskDetails,
  editTask, type EditableFields,
  type Actor, type CreateTaskInput, type MovePatch,
} from './tasks.js';
export {
  syncChannelMap, listChannelMap, mapChannelToSpace, unmapChannel,
  type ChannelMapConfig, type ChannelMapEntry, type SyncResult,
} from './channel-map.js';
export {
  getSpaceForChannel, findSpaceExact, resolveDestinationSpace,
  type ChannelSpace, type Destination, type DestinationRequest,
} from './context.js';
export {
  listTasks, listWaiting, getTaskCounts,
  type ListTasksFilter, type SpaceCount, type DueBucket,
} from './queries.js';
export {
  openCountBySpace, completedBetween, createdBetween, createdThisWeek,
  completedThisWeek, averageTaskAgeDays, staleTasks, startOfWeek,
  type SpaceOpenCount,
} from './reports.js';
