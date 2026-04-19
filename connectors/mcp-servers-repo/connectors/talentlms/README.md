# @mindstone-engineering/mcp-server-talentlms

[![npm version](https://img.shields.io/npm/v/@mindstone-engineering/mcp-server-talentlms.svg)](https://www.npmjs.com/package/@mindstone-engineering/mcp-server-talentlms)
[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](./LICENSE)

TalentLMS MCP server for Model Context Protocol hosts. Manage users, courses, groups, branches, enrolments, reporting, and assessments in TalentLMS through a standardised MCP interface.

## Requirements

- Node.js 20+
- npm

## Quick Start

### Install & build

```bash
cd <path-to-repo>/connectors/talentlms
npm install
npm run build
```

### npx (once published)

```bash
npx -y @mindstone-engineering/mcp-server-talentlms
```

### Local

```bash
node dist/index.js
```

## Configuration

### Environment variables

- `TALENTLMS_API_KEY` — TalentLMS API key
- `TALENTLMS_DOMAIN` — TalentLMS subdomain (e.g. `acme` for acme.talentlms.com)
- `TALENTLMS_REQUEST_TIMEOUT` — request timeout in milliseconds (default: `30000`)
- `MCP_HOST_BRIDGE_STATE` — optional path to a host bridge state file used for credential management
- `MINDSTONE_REBEL_BRIDGE_STATE` — backwards-compatible alias for `MCP_HOST_BRIDGE_STATE`

## Host configuration examples

### Claude Desktop / Cursor

```json
{
  "mcpServers": {
    "TalentLMS": {
      "command": "npx",
      "args": ["-y", "@mindstone-engineering/mcp-server-talentlms"],
      "env": {
        "TALENTLMS_API_KEY": "your-api-key",
        "TALENTLMS_DOMAIN": "your-domain"
      }
    }
  }
}
```

### Local development (no npm publish needed)

```json
{
  "mcpServers": {
    "TalentLMS": {
      "command": "node",
      "args": ["<path-to-repo>/connectors/talentlms/dist/index.js"],
      "env": {
        "TALENTLMS_API_KEY": "your-api-key",
        "TALENTLMS_DOMAIN": "your-domain"
      }
    }
  }
}
```

## Tools (24)

### Configuration
- `configure_talentlms` — Configure TalentLMS API credentials

### Users
- `list_talentlms_users` — List all users
- `get_talentlms_user` — Get a user's full profile by ID or email
- `create_talentlms_user` — Create a new user
- `set_talentlms_user_status` — Activate or deactivate a user
- `get_talentlms_user_courses` — Get all courses a user is enrolled in

### Courses
- `list_talentlms_courses` — List all courses
- `get_talentlms_course` — Get full course details by ID
- `create_talentlms_course` — Create a new course
- `get_talentlms_course_users` — Get all users enrolled in a course
- `enrol_talentlms_user` — Enrol a user into a course
- `unenrol_talentlms_user` — Remove a user from a course
- `get_talentlms_course_sso_link` — Generate an SSO link to launch a user into a course

### Groups
- `list_talentlms_groups` — List all groups
- `get_talentlms_group` — Get group details including members and courses
- `create_talentlms_group` — Create a new group
- `add_course_to_talentlms_group` — Assign a course to a group

### Branches
- `list_talentlms_branches` — List all branches (multi-tenant)

### Reporting
- `get_talentlms_site_info` — Get site-level statistics and configuration
- `get_talentlms_timeline` — Get activity timeline for users or courses
- `get_talentlms_user_progress` — Get detailed progress for a user in a course

### Assessments
- `get_talentlms_test_answers` — Get a user's answers for a test/quiz
- `get_talentlms_survey_answers` — Get a user's responses to a survey
- `get_talentlms_ilt_sessions` — Get instructor-led training sessions for a unit

## Licence

[FSL-1.1-MIT](./LICENSE) — Functional Source License, Version 1.1, with MIT future licence. The software converts to MIT licence on 2030-04-08.
