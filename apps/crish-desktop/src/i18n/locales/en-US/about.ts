import type { AboutTranslations } from '../../types';

export const about: AboutTranslations = {
  // Brand & Application Titles
  pageTitle: 'About',
  title: 'About',
  appName: 'Crish Desktop',
  appDescription:
    'Modern local-first autonomous agent desktop workbench and multi-model collaborative development environment',
  description:
    'Modern local-first autonomous agent desktop workbench and multi-model collaborative development environment',
  appInfo: 'Application Information',
  appVersion: 'App Version',
  appVersionLabel: 'App Version',
  kernelVersion: 'Kernel Version',
  kernelVersionLabel: 'Conex Kernel Version',
  kernelDesc: 'Rust kernel session engine and orchestration core',
  systemArch: 'System & Runtime Architecture',

  // System Information
  systemSectionTitle: 'Application & System Information',
  systemInfo: 'System Information',
  osLabel: 'Operating System',
  osVersion: 'OS Version',
  archLabel: 'Architecture',
  architecture: 'Architecture',
  runtimeLabel: 'Runtime',
  copySysInfo: 'Copy System Info',
  copySysInfoBtn: 'Copy System Info',
  copySysInfoTooltip:
    'Copy operating system, application version, and kernel architecture info',
  copySysInfoSuccess: 'System information copied to clipboard',
  sysInfoCopied: 'System Info Copied',
  sysInfoCopiedToast: 'System information copied to clipboard',

  // Main License
  mainLicenseSectionTitle: 'Software Main License',
  openSourceLicense: 'Open Source License',
  primaryLicense: 'Primary License (MIT)',
  mainLicenseName: 'The MIT License',
  mainLicenseCopyright: 'Copyright (c) 2026 Conex Community',
  viewMainLicenseAction: 'View Full LICENSE',
  viewLicense: 'View License',
  mitLicenseText:
    'This software is open source under the MIT License. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files, to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software.',

  // Third-Party Disclosures
  thirdPartySectionTitle: 'Third-Party Open Source Notices & Legal Compliance',
  thirdPartyTitle: 'Third-Party Open Source Licenses & Disclosures',
  thirdPartySubtitle:
    'Crish Desktop and Conex Kernel are made possible by the following open source projects.',
  thirdPartyNotices: 'Third-Party Open Source Dependencies & Licenses',
  thirdPartyDesc:
    'Includes permissive dependencies, MPL-2.0 reciprocity notices, SIL OFL-1.1 font licenses, and commercial model trademark notices.',
  toggleViewThirdParty: 'View Third-Party Licenses',
  toggleCollapseThirdParty: 'Collapse Third-Party Licenses',
  viewThirdParty: 'View Third-Party Notices',
  viewFullLicenseModal: 'View Full License Modal',
  modalViewAction: 'Open Full Disclosures Modal',
  modalTitle: 'Third-Party Open Source License Disclosures',
  modalCloseBtn: 'Close',
  thirdPartyModalTitle: 'Third-Party Open Source License Disclosures',

  // License Categories & Compliance
  permissiveTitle: 'Permissive Open-Source Libraries',
  permissiveDesc:
    'Crish Desktop includes and depends on numerous projects licensed under permissive open-source licenses. These projects are distributed under their respective terms, with complete copyright notices and license texts preserved in their source code and distribution packages:',
  mplTitle: 'Mozilla Public License 2.0 (MPL-2.0) Reciprocity Notice',
  mplDisclosureNotice:
    'In compliance with Sections 3.1 and 3.2 of MPL-2.0, this project fulfills source code distribution notice obligations for included MPL-licensed components. These libraries remain distinct and uncombined, and their respective upstream source forms are accessible at their upstream repositories.',
  mplViewSourceAction: 'Source',
  weakCopyleftTitle: 'Weak Copyleft Disclosures (MPL-2.0 Section 3.1 & 3.2)',
  weakCopyleftDesc:
    'In compliance with Sections 3.1 and 3.2 of the Mozilla Public License 2.0 (MPL-2.0), this project discloses the following third-party components referenced in unmodified library form. You may access and obtain their complete source code via the links below:',
  weakCopyleftSourceNotice:
    'In compliance with Sections 3.1 and 3.2 of the Mozilla Public License 2.0 (MPL-2.0), this project fulfills source code notice obligations.',
  unmodifiedForm: 'Unmodified Library Form',
  fontsTitle: 'Bundled Font Licenses (SIL OFL-1.1)',
  fontsOflNotice:
    'Inter, JetBrains Mono, and IBM Plex fonts are bundled under the terms of the SIL Open Font License, Version 1.1, permitting free bundling and rendering.',
  fontsDesc:
    'This project bundles and uses the following open-source font families, all distributed under the SIL Open Font License 1.1 (SIL OFL-1.1):',
  trademarkTitle: 'Commercial LLM Trademark Fair Use Notice',
  trademarkFairUseNotice:
    'OpenAI, Anthropic, Google Gemini, DeepSeek, and other trademarks and logos are the property of their respective owners. Crish Desktop and Conex Kernel are independently developed open source software tools. Reference to these commercial trademarks is solely for model connection, protocol adaptation, and technical interoperability under Fair Use principles, and does not imply any affiliation, sponsorship, or endorsement.',
  trademarkDesc:
    'OpenAI, Anthropic, Google Gemini, DeepSeek, and other trademarks and logos are the property of their respective owners. Crish Desktop and Conex Kernel are independently developed open source software tools. Reference to these commercial trademarks is solely for model connection, protocol adaptation, and technical interoperability under Fair Use principles, and does not imply any affiliation, sponsorship, or endorsement.',

  // Dependency Descriptions (Tree + Flat dot notation)
  dependencyDesc: {
    bitmaps: 'Fixed-capacity high-performance bitmap data structures',
    cssparser: 'CSS Syntax Level 3 compliant parser in Rust',
    cssparserMacros: 'Procedural macros for cssparser',
    im: 'Immutable collection datatypes for Rust',
    sizedChunks: 'Sized chunk buffers for immutable collections',
    lightningcss: 'Extremely fast CSS parser, transformer, and minifier',
    parcelWatcher: 'Cross-platform native filesystem event monitoring',
    interFont: 'Modern sans-serif typeface designed for screen readability',
    jetbrainsMonoFont: 'Monospaced typeface optimized for coding and alignment',
    ibmPlexFont: 'IBM official high-legibility open source font family',
  } as unknown as string,
  'dependencyDesc.bitmaps':
    'Fixed-capacity high-performance bitmap data structures',
  'dependencyDesc.cssparser': 'CSS Syntax Level 3 compliant parser in Rust',
  'dependencyDesc.cssparserMacros': 'Procedural macros for cssparser',
  'dependencyDesc.im': 'Immutable collection datatypes for Rust',
  'dependencyDesc.sizedChunks': 'Sized chunk buffers for immutable collections',
  'dependencyDesc.lightningcss':
    'Extremely fast CSS parser, transformer, and minifier',
  'dependencyDesc.parcelWatcher':
    'Cross-platform native filesystem event monitoring',
  'dependencyDesc.interFont':
    'Modern sans-serif typeface designed for screen readability',
  'dependencyDesc.jetbrainsMonoFont':
    'Monospaced typeface optimized for coding and alignment',
  'dependencyDesc.ibmPlexFont':
    'IBM official high-legibility open source font family',

  // Community & External Links
  communityTitle: 'Community & Support',
  repoLinkText: 'GitHub Source Repository',
  githubRepo: 'GitHub Source Repository',
  visitRepo: 'Visit Repository',
  securityReport: 'Security Vulnerability Report',
  securityReportText: 'Security Vulnerability Disclosure Program',
  securityReportDesc:
    'If you discover a security vulnerability, please report it via GitHub Security Advisories or security@conex.dev',
  submitVulnerability: 'Submit Vulnerability',

  // Historical Keys
  noticeTitle: 'Notices',
  checkUpdates: 'Check for Updates',
  checkUpdatesDesc:
    'Check the Minisign-signed update channel for new versions; install from the sidebar when found',
  checkingUpdates: 'Checking for updates...',
  // Update pipeline (updateStore · RUN-03/GAP-01)
  noUpdateAvailable: 'No update available',
  tasksRunningBlockUpdate:
    'Tasks are still running. Please wait for them to finish before updating',
  applyUpdateFailed: 'Update failed',
  applyUpdateFailedDetail: 'Update failed: {error}',
  updateChannelUnavailable: 'Update channel unavailable',
  updateInstalledRestart:
    'Update installed. Please restart the app to complete the update',
  checkUpdateFailedDetail: 'Failed to check for updates: {error}',
  upToDate: 'Up to Date',
  updateAvailable: 'Update Available',
  newVersionAvailable: 'New version available: {version}',
  updateFailed: 'Failed to check for updates',
  webviewVersion: 'WebView Version',
  rustVersion: 'Rust Kernel Version',
  nodeVersion: 'Node.js Version',
  releaseNotes: 'Release Notes',
  privacyPolicy: 'Privacy Policy',
  termsOfService: 'Terms of Service',
  acknowledgements: 'Acknowledgements',
  copyright: '(c) {year} Conex. All rights reserved.',
};

export default about;
