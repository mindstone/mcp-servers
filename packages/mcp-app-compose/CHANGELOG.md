# Changelog

All notable changes to this package are documented here.

This file follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
format and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-06

### Added

- Initial extraction of the shared compose/send MCP-App iframe HTML into a
  build-time generator: `buildComposeAppHtml(config)` parameterizes resource
  URI, send-tool name, From-helper copy, CC/BCC field visibility, and the
  deep-link subsystem (closed `gmail`/`none` discriminator). With the Gmail
  configuration the output is byte-identical to the template previously
  hand-maintained in the google-workspace connector.
