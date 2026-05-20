export const MOCK_API_KEY = 'mcp-test-opus-key';

export const mockProjectId = 'P2061602abcd';
export const mockClipId = 'qU3iVMSO77';
export const mockCurationId = 'CU67da38';
export const mockFullClipId = `${mockProjectId}.${mockCurationId}`;
export const mockCollectionId = 'xmAwhhFi0IJt';
export const mockJobId = '96e3d68c-49ef-4c19-b3b6-595f9564537c';
export const mockCensorJobId = 'censor-job-xyz';
export const mockUploadId = 'upload-abc123';
export const mockScheduleId = '1772177588135sHuZ-FACEBOOK_PAGE';
export const mockPostId = '17722461986440WKW-FACEBOOK_PAGE';
export const mockPostAccountId = 'postAccountId_xxx1';
export const mockSubAccountId = 'subAccountId_xxx1';

export const mockBrandTemplates = [
  {
    id: 'preset-fancy-Karaoke',
    name: 'Karaoke',
  },
  {
    id: 'preset-fancy-Minimal',
    name: 'Minimal',
  },
];

export function makeProjectResponse(stage: string = 'QUEUED') {
  return {
    id: mockProjectId,
    projectId: mockProjectId,
    stage,
    model: 'ClipBasic',
    sourcePlatform: 'UPLOADED',
    isDeleted: false,
    isPurged: false,
    error: null,
  };
}

export const mockUploadLinkResponse = {
  url: 'https://storage.googleapis.com/ext.gcs.opus.pro/upload/org_xxx/google-upload',
  uploadId: mockUploadId,
  dnsUrl: 'https://api.opus.pro',
  useAmount: 0,
  totalAmount: 107974182498,
};

export const mockResumableLocation = 'https://storage.googleapis.com/ext.gcs.opus.pro/upload/org_xxx/google-upload?upload_id=AAkIAwy-YC6V';

export function makeCensorJobResponse() {
  // Opus wraps the response in `{data: ...}` in live deployments.
  return {
    data: {
      jobId: mockCensorJobId,
      message: 'Censor job queued.',
    },
  };
}

export function makeCensorJobNoWords() {
  return {
    data: {
      message: 'No censored words found',
    },
  };
}

export function makeCensorJobStatus(status = 'PROCESSING') {
  return { status };
}

export function makeSocialAccounts() {
  return {
    data: [
      {
        postAccountId: mockPostAccountId,
        subAccountId: mockSubAccountId,
        platform: 'FACEBOOK_PAGE',
        extUserId: 'extUserId_xxx',
        extUserName: 'Page Name',
        extUserPictureLink: 'https://example.com/avatar.png',
        extUserProfileLink: 'https://www.facebook.com/page_id',
      },
    ],
  };
}

export function makeCollection() {
  return {
    data: {
      collectionId: mockCollectionId,
      collectionName: 'Opus demo clips',
    },
  };
}

export function makeCollectionList() {
  return {
    data: {
      list: [
        {
          collectionId: mockCollectionId,
          collectionName: 'Opus demo clips',
        },
      ],
      total: 1,
      next: null,
      limit: null,
    },
  };
}

export function makeCollectionExport() {
  return {
    data: {
      contentList: [
        {
          contentId: mockFullClipId,
          uriForExport:
            'https://ext.cdn.opus.pro/media/org_xxx/google-oauth2|xxx/P2061602abcd/c.CU67da38/ehd.mp4?v=123',
        },
      ],
    },
  };
}

export function makeSocialCopyResult(status: 'RUNNING' | 'COMPLETED' | 'FAILED' = 'COMPLETED') {
  if (status === 'COMPLETED') {
    return {
      data: {
        jobId: mockJobId,
        status,
        cached: false,
        title: 'Demo Title',
        description: 'Demo description with hashtags.',
        hashtags: '#Demo #Opus',
      },
    };
  }
  return {
    data: {
      jobId: mockJobId,
      status,
    },
  };
}
