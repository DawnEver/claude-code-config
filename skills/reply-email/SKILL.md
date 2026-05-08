---
name: reply-email
description: Generate natural, conversational English email replies. Provide the received email and your draft/key points, and get a polished reply.
disable-model-invocation: true
allowed-tools: "Read"
---

# Email Reply Generator

Generate natural, fluent, conversational English email replies.

## Workflow

1. **Gather input information**:
   - The received email content
   - The user's reply draft or key points (can be in Chinese or English)

2. **Generate the reply**:
   - Use conversational, natural English
   - Maintain politeness and professionalism
   - Ensure the reply fully covers all the user's key points

## Reply Style Requirements

- **Conversational but professional**: Like a real conversation, but still maintaining appropriate professional tone
- **Fluent and natural**: Avoid awkward translation feeling
- **Concise and clear**: Don't be overly verbose
- **Friendly**: Use a positive tone

## Reply Structure

```
Subject: Re: [Original subject]

Hi [Name],

[Body - natural, fluent reply]

Best,
[Your name]
```

## Usage Example

**Input**:
Received email:
```
From: prof.smith@nottingham.ac.uk
Subject: Meeting about research project

Dear Lin,

I'd like to discuss your research project progress. Are you free this Friday afternoon?

Best,
Prof. Smith
```

User draft: "Okay, Friday 3pm works, please let me know the meeting room location"

**Output**:
```
Subject: Re: Meeting about research project

Hi Prof. Smith,

Thanks for reaching out! Friday afternoon at 3pm works perfectly for me. Could you let me know which meeting room we'll be in?

Looking forward to our discussion.

Best,
Lin
```

## How to Use

Invoke this skill with `/reply-email`, then:
1. Paste the received email content
2. Provide your reply draft or key points
3. Receive a polished English reply
