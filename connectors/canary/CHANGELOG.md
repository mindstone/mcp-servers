# Changelog

All notable changes to this connector are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.2] - 2026-05-29

### Changed

- Tweak canary pong response to v2

## [0.0.1] - 2026-05-26

### Added
- Initial canary release. Single `ping` tool that returns `pong: <message>`.
  Used to validate the rebel-oss release pipeline end-to-end without
  exercising any real connector logic, auth, or external API.
