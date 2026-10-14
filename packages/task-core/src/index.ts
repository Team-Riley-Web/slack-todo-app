export * from './types.js';
export * from './errors.js';
export {
  PRIORITIES, PRIORITY_LABELS, InvalidPriorityError,
  isPriority, parsePriority, priorityRank, comparePriority, priorityChoice,
  type Priority,
} from './priority.js';
export {
  deleteSpace, createSpace, setSpaceName, slugForSpace,
  type DeleteSpaceResult, type CreateSpaceResult, type SetSpaceNameResult,
} from './spaces.js';
export { parseCapture, type Capture, type CaptureOptions } from './capture.js';
// Named for what it does to a string, not for what it is applied to: the
// guards in tasks.test.ts assert task-core exports nothing matching
// /title|rename/i, so there is exactly one obvious title write path.
export { capitalizeFirstLetter } from './capitalize.js';
export { parseAssigneeLabels, assigneeChoices } from './assignees.js';
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
  listTasks, listWaiting, getTaskCounts, TASK_ORDER_BY,
  type ListTasksFilter, type SpaceCount, type DueBucket,
} from './queries.js';
export {
  DEFAULT_TIME_ZONE, parseDueInput, formatDueInput, calendarDaysFrom, tomorrowAt,
  resolveDueChoice, describeDueChoice, type DueWhen, type DueChoice,
} from './due.js';
export {
  listOpenTasksBySpace, matchesSpaceKeys, PERSONAL_SPACE_SLUG,
  type TaskInSpace, type TaskGroup, type GroupedTasks,
  type SpacePredicate, type GroupedTasksOptions,
} from './grouping.js';
export {
  openCountBySpace, completedBetween, createdBetween, createdThisWeek,
  completedThisWeek, averageTaskAgeDays, staleTasks, startOfWeek,
  type SpaceOpenCount,
} from './reports.js';
