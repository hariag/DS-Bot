# The vision of DS Bot

English | [中文](vision.zh.md)

This file says what DS Bot is meant to be, why, and what it does not do. For how to use it, see the [README](../README.md); for the designs that are decided, see [docs/plans/](plans/) (written in Chinese); for how to take part, see [CONTRIBUTING](../CONTRIBUTING.md).

## What DS Bot is

DS Bot is a team of long-lived Bots, built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It is open source under the Apache 2.0 license. The user does not chat with one assistant but leads a team with clear roles: one or more Main Bots organize the work, the other Bots each do their own part and talk to each other, and the user can see at any time who is doing what.

## Two forms

| Form | What it is |
|---|---|
| The `ds-bot` plugin | A standard DSH plugin for DSH Desktop and DSH Web. All the Bot features are here |
| The DS Bot desktop app | Opens straight into DS Bot. It brings a pinned DSH, its own profile and its own data folder, imports a team the user already has in DSH, and installs DSH-compatible plugins, so that DS Bot grows its own plugin ecosystem. The plugin can still be used on its own |

Both forms run the same `ds-bot` plugin. The point of the app is that DS Bot controls its own profile and interface, free of the limits of DSH's general interface and global settings (see the [DSH concessions](plans/2026-10-13-dsh-concessions.md)).

## Ten core requirements

1. **Built on DSH.** Every Bot is a DSH Session and runs through the normal DSH agent loop, tools and model routes. DS Bot follows DSH's plugin model and uses only documented interfaces. It does not patch DSH and does not add a second agent runtime.
2. **The team comes first.** The point is many Bots working together, not one Bot. Bots message each other and share group chats. A Main Bot has the highest rights: it creates, changes and removes other Bots, and there can be more than one. Other Bots do not get these rights.
3. **Clear roles.** Each Bot has its own role; a team is not a set of Bots that all do the same thing.
4. **A polished interface with careful motion.** Motion is smooth and has a cause: a change of state has a transition, an action has feedback, nothing moves for its own sake.
5. **Independent, and visible to each other.** Each Bot works on its own and does not disturb the others; when it needs to, it can see what the others are doing.
6. **One Bot, one continuous conversation.** The user sees one continuous chat. When the context fills up, the Bot moves on to a new part (a new DSH Session) and the old part goes into a searchable index, instead of compacting again and again and losing detail.
7. **Active memory.** Bots have a memory and look things up in it themselves, not only through what is injected.
8. **Reliable.** Bots stay aligned with the goal, act on evidence, stay inside their task, and their results can be checked. When unsure, a Bot looks it up or asks instead of guessing.
9. **Customizable.** Users customize each Bot: name, role label, instructions, model, character; later also the system prompt and even the harness each Bot runs on.
10. **Other local agents can join.** Later, other agents on the same computer (for example through their command line) can join the team.

## Principles for trade-offs

- **Correct Bot behavior comes first.** Where a DSH mode or limit does not fit Bots, DS Bot does not pile up complexity to stay compatible. Concessions that cannot be avoided go into the [DSH concessions](plans/2026-10-13-dsh-concessions.md), to be removed once the app controls its own profile.
- **Data stays on the user's computer.** Teams, chats and memory live in the local DSH data folder.
- **Only original material.** No code, text, icons or graphics copied from other products.
- **Done means checked.** Behavior is covered by tests; interface changes are looked at for real.

## What DS Bot does not do

- It does not patch DSH or depend on internal files of a DSH install.
- It does not add its own agent runtime or go around DSH's tools and permissions.
- It is not a hosted service: DS Bot runs in the user's own DSH.

## Who sets the direction

The maintainer decides the direction of the product, changes to decided designs, the rules for working together, releases and the architecture. Anyone can do the rest of the work; see [CONTRIBUTING](../CONTRIBUTING.md#how-we-work).
