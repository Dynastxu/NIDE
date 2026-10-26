# AGENTS.md

Rules for working in this repository.

## Project Description
- `docs/wiki/` contains the GitHub Wiki repository. Read it to understand the project structure. Documentation may be outdated; the code logic shall prevail. If there is no content, tell the user to clone the Wiki repository to the target location; do not clone it yourself.

## Code Design Principles

All code written in this project must adhere to the following SOLID principles:

- **Single Responsibility Principle (SRP)**: Each class should have only one reason to change. A class should focus on a single responsibility.
- **Open/Closed Principle (OCP)**: Software entities should be open for extension but closed for modification. Prefer extending behavior through interfaces, inheritance, or composition rather than modifying existing code.
- **Liskov Substitution Principle (LSP)**: Subtypes must be substitutable for their base types without altering the correctness of the program. Derived classes must not violate the contracts of their base classes.
- **Interface Segregation Principle (ISP)**: Clients should not be forced to depend on interfaces they do not use. Prefer small, focused interfaces over large, monolithic ones.
- **Dependency Inversion Principle (DIP)**: Depend on abstractions, not on concretions. High-level modules should not depend on low-level modules; both should depend on abstractions.

All code written in this project must also follow these design guidelines:

- **UX/DX/AX Balance**: Every modification must balance User Experience (UX), Developer Experience (DX), and AI Agent usage experience (AX). All three must improve, and existing functionality must not be broken.
- **UI Simplicity**: For UI/frontend code: delete redundant slogans, explanatory text, and secondary labels. If the interface becomes incomprehensible after removing them, the layout itself is flawed—propose a redesign rather than adding text back.

## User
- When the user refuses to run tests, builds, or other commands with elevated privileges, stop trying, and do not use any method to attempt to run them without elevated privileges.
- Without the user's permission, git commands may be executed only if they are read-only; all other git commands must not be executed.
