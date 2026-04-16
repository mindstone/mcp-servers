export declare const REQUEST_TIMEOUT_MS = 30000;
export declare const FATHOM_API_BASE = "https://api.fathom.ai/external/v1";
export interface BridgeState {
    port: number;
    token: string;
}
export declare class FathomError extends Error {
    readonly code: string;
    readonly resolution: string;
    constructor(message: string, code: string, resolution: string);
}
export interface TranscriptEntry {
    speaker: {
        name?: string;
        display_name?: string;
        email?: string;
        matched_calendar_invitee_email?: string;
    };
    start_time?: number;
    end_time?: number;
    timestamp?: string;
    text: string;
}
export interface TranscriptResponse {
    transcript: TranscriptEntry[];
}
export interface MeetingItem {
    title: string;
    meeting_title: string | null;
    recording_id: number;
    url: string;
    share_url: string;
    created_at: string;
    scheduled_start_time: string;
    scheduled_end_time: string;
    recording_start_time: string;
    recording_end_time: string;
    calendar_invitees_domains_type: string;
    transcript_language: string;
    calendar_invitees: Array<{
        name?: string;
        email: string;
        email_domain?: string;
        is_external?: boolean;
    }>;
    recorded_by: {
        name?: string;
        email: string;
        email_domain?: string;
        team?: string | null;
    };
    default_summary?: {
        template_name?: string;
        markdown_formatted?: string;
    } | null;
    action_items?: Array<{
        description: string;
        user_generated?: boolean;
        completed?: boolean;
        recording_timestamp?: string;
        assignee?: {
            name?: string;
            email?: string;
        };
    }> | null;
}
export interface MeetingsListResponse {
    limit: number;
    next_cursor: string | null;
    items: MeetingItem[];
}
export interface TeamItem {
    name: string;
    created_at?: string | null;
}
export interface TeamsResponse {
    limit: number;
    next_cursor: string | null;
    items: (TeamItem | string)[];
}
export interface TeamMembersResponse {
    limit: number;
    next_cursor: string | null;
    items: Array<{
        id?: string;
        email?: string;
        name?: string;
        role?: string;
        joined_at?: string;
    }>;
}
export interface SummaryResponse {
    summary: {
        template_name?: string;
        markdown_formatted?: string;
    };
}
//# sourceMappingURL=types.d.ts.map