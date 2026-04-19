/**
 * Kling test data fixtures.
 */

export const mockTaskId = 'task-kling-abc123';
export const mockI2vTaskId = 'task-i2v-456';

export const mockVideoResult = {
  task_id: mockTaskId,
  task_status: 'succeed' as const,
  task_status_msg: 'Generation completed',
  task_result: {
    videos: [
      {
        url: 'https://cdn.klingai.com/video/abc123.mp4',
        duration: '5',
        aspect_ratio: '16:9',
      },
    ],
  },
};

export const mockProcessingResult = {
  task_id: mockTaskId,
  task_status: 'processing' as const,
  task_status_msg: 'Video is being generated',
};

export const mockFailedResult = {
  task_id: mockTaskId,
  task_status: 'failed' as const,
  task_status_msg: 'Content policy violation',
};

export const mockVideoGenerationResponse = {
  task_id: mockTaskId,
};

export const mockI2vGenerationResponse = {
  task_id: mockI2vTaskId,
};
