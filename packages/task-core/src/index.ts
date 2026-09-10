export * from './types.js';
export * from './errors.js';
export { parseCapture, type Capture, type CaptureOptions } from './capture.js';
export {
  listSpaces, getInboxSpace, resolveSpaceForChannel, findSpaceByQuery,
} from './spaces.js';
export {
  createTask, getTask, completeTask, reopenTask, moveTask, updateTaskDetails,
  type Actor, type CreateTaskInput, type MovePatch,
} from './tasks.js';
export {
  syncChannelMap, listChannelMap,
  type ChannelMapConfig, type ChannelMapEntry, type SyncResult,
} from './channel-map.js';
export {
  getSpaceForChannel, findSpaceExact, resolveDestinationSpace,
  type ChannelSpace, type Destination, type DestinationRequest,
} from './context.js';
export {
  listTasks, listWaiting, getTaskCounts,
  type ListTasksFilter, type SpaceCount,
} from './queries.js';
