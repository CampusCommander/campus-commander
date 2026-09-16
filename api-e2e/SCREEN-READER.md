# Phase 2 screen-reader qualification

The screen-reader target runs the rendered all-Docker application with Chromium, Orca, Speech Dispatcher, and eSpeak.
It uses a private D-Bus session, Xvfb display, configuration directory, and speech socket.
The ALSA null device discards audio. The test verifies actual reader utterances without changing the desktop audio configuration.

Install Orca, Speech Dispatcher, its eSpeak module, Xvfb, and D-Bus in the Linux qualification environment.
The local fixture supports an extracted Ubuntu amd64 dependency tree through `CC_ORCA_ROOT`.
That tree must include Orca Python dependencies, GI typelibs, speech modules, speech plugins, voice data, and compiled Orca GSettings schemas.
Omit `CC_ORCA_ROOT` when those dependencies exist in their standard system locations.

```sh
npx nx run api-e2e:screen-reader-integration
```

The target requires the same application images and Docker access as `all-docker-integration`.
Published image references use `CC_AUTH_API_IMAGE`, `CC_AUTH_FRONTEND_IMAGE`, and `CC_AUTH_WORKER_IMAGE`.
The fixture focuses controls before keyboard activation and captures Orca output after sign-out.
It checks the login label, diagnostic controls, named service completion, bounded announcements, and sign-out.

The report resides at `dist/phase-2-evidence/screen-reader.json`.
Raw reader logs remain in the private temporary evidence directory named by that report.
The report distinguishes reader output from human listening and usability evaluation.
Do not infer full accessibility conformance from this target.

Applicable rules: UI-09 and UI-10.
The [Orca command reference](https://help.gnome.org/orca/introduction.html) documents its debug output option.
