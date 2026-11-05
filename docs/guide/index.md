# What is imap-mcp?

An MCP server for any IMAP mailbox: find the mail, read it, file it — with every message fenced as untrusted content and the write tools off unless you turn them on.

## Why

A mailbox is the richest source of context most people have, and the most dangerous one to hand a model: every word in it was written by someone else. This server is built around that.

## What it is not

Sending mail. This server has no SMTP path at all, so no instruction found in a message can be carried out by it — which is what makes the untrusted-content framing worth anything.
