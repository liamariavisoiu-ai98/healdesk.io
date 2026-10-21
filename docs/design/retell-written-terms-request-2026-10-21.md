# Request to Retell AI: written answers on the native LLM path (draft, not sent)

For the Owner to send from the account that signed Retell's BAA, to
support@retellai.com (Retell's documentation directs subprocessor questions
there). Claude has not sent this and will not. Replace the bracketed parts. Do
not include any patient data.

**Subject:** HIPAA workspace [workspace name]: written answers needed before we use Retell LLM for patient calls

Hello,

We are a Business Associate of the clinics we serve and we signed Retell's BAA
through click-agreements on [date]. We are moving our voice agents from a
custom-LLM WebSocket to Retell's native LLM (`retell-llm`) and need these points
in writing before any call carrying protected health information uses it:

1. **Scope of the BAA.** Does the executed BAA cover LLM inference done by Retell's
   native LLM, including prompts, tool-call inputs and outputs, and transcripts?
2. **Subprocessors.** Which model providers and cloud regions process call
   content for each model Retell offers (we are considering the Claude Sonnet and
   Haiku models)? Under which agreements (BAA or equivalent) does each process it?
   Is there a current subprocessor list, and how are changes notified?
3. **Provider retention.** For each of those providers, is prompt/response data
   retained, for how long, and is it used for training? Is zero retention
   available or on by default for our workspace?
4. **Retell retention.** With `data_storage_setting` set to `basic_attributes_only`,
   do the `call_ended` / `call_analyzed` webhooks still carry the transcript? If
   not, which setting delivers a transcript in the webhook while keeping no
   recording? What is deleted when we call delete-call, and how long do backups
   of deleted data live?
5. **Guardrails.** Can output-guardrail topics be customised, and can the
   replacement text be set? Is there any hook that lets us screen a caller's
   utterance before the LLM sees it?
6. **Failure behaviour.** What happens to a call when (a) the LLM provider
   fails, (b) our inbound-call webhook times out, (c) a custom function endpoint
   times out? Is there a deterministic transfer to a number we configure?
7. **Live control.** Can an in-progress call be transferred, ended or redirected
   through the API when our `transcript_updated` webhook endpoint detects an
   urgent symptom? What is the webhook's typical latency?
8. **Incidents.** Contact and timelines for breach notification under the BAA.

Please reply in writing; we will keep your answer with our compliance records.

[Name, role, company, contact]
