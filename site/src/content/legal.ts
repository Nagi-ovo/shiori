import type { Lang } from "../i18n/dict";

// Formal legal / compliance copy for the standalone Privacy Policy and
// Support pages. These are the pages an App Store / Google Play reviewer
// reads, so they're written as plain prose with numbered sections, a
// "last updated" date, and a real contact email — not the marketing
// voice used on the homepage. URLs and emails in the body are turned
// into links by linkify() at render time.

// Bump when the substance of the policy changes. Shown verbatim under
// each page title. ISO date keeps it unambiguous across locales.
export const LEGAL_UPDATED = "2026-10-17";

// Single contact address for privacy + support enquiries. Stores expect
// a reachable email; Discord/GitHub are offered in addition, not instead.
export const CONTACT_EMAIL = "nagiovo.dev@gmail.com";

export type LegalBlock = { p: string } | { list: string[] };

export type LegalSection = {
  heading: string;
  blocks: LegalBlock[];
};

export type LegalDoc = {
  kicker: string;
  title: string;
  updatedLabel: string;
  intro: string;
  sections: LegalSection[];
};

export const PRIVACY_DOC: Record<Lang, LegalDoc> = {
  en: {
    kicker: "Privacy Policy",
    title: "Privacy Policy",
    updatedLabel: "Last updated",
    intro:
      "Shiori is a local-first document reader and PDF editor for macOS, Windows, Linux, iOS, and Android. It is built so that your documents and your work stay on your own device. This policy explains, in plain terms, what data Shiori does and does not handle.",
    sections: [
      {
        heading: "1. Summary",
        blocks: [
          {
            p: "Shiori has no user accounts, no servers that store your content, and no advertising. The desktop and mobile apps contain no analytics of any kind; the web version counts anonymous visits only (section 4). We do not collect, sell, or share personal information. The short version: your files are yours, and they stay on your device.",
          },
        ],
      },
      {
        heading: "2. Information we do not collect",
        blocks: [
          {
            p: "Shiori does not require you to create an account or sign in. We do not collect any of the following:",
          },
          {
            list: [
              "Names, email addresses, or contact details (unless you choose to email us — see section 10).",
              "The contents of the PDF, Markdown, or HTML documents you open, or the annotations you make.",
              "Usage analytics, behavioral tracking, or telemetry of any kind in the desktop and mobile apps. The web version counts anonymous visits only, as described in section 4.",
              "Advertising identifiers, location data, contacts, photos, microphone, or camera access.",
            ],
          },
        ],
      },
      {
        heading: "3. Where your data is stored",
        blocks: [
          {
            p: "Everything Shiori creates is written to local storage on your own device, never to our servers. This includes the documents you open, your annotations, your recently-opened list, your theme and language preferences, a short error log on desktop, and, if you use the Browser panel, the cookies and site data of the pages you visit there.",
          },
          {
            p: "On desktop, this lives in folders named after Shiori's app ID, fun.nagi.shiori: on macOS inside ~/Library/WebKit, ~/Library/Application Support, ~/Library/Caches and ~/Library/Logs (plus the file ~/Library/Preferences/fun.nagi.shiori.plist); on Windows inside %LOCALAPPDATA% and %APPDATA%; on Linux inside ~/.local/share, ~/.config and ~/.cache. In the web version, it lives in your browser's storage for app.shiori.nagi.fun. On iOS and Android, it lives inside the app's private sandbox managed by the operating system. You can back this data up, copy it, or delete it at any time. Uninstalling the app on iOS or Android deletes it; on desktop, uninstalling usually leaves these folders behind, so delete them yourself to remove everything. For the web version, clear your browser's site data for app.shiori.nagi.fun.",
          },
        ],
      },
      {
        heading: "4. This website and the web version",
        blocks: [
          {
            p: "When your browser loads this website or the web version of Shiori (https://app.shiori.nagi.fun) from our static hosting provider, Cloudflare, the provider receives your IP address and basic request information, as happens with any website you visit. This is used only to deliver the page and to protect against abuse. Neither carries advertising, and this website carries no analytics or tracking scripts.",
          },
          {
            p: "The web version uses Cloudflare Web Analytics to count visits in aggregate: page views, referring site, country, and browser type. It sets no cookies, does not fingerprint or identify individual visitors, and never sees your documents, which are opened and processed entirely inside your browser.",
          },
        ],
      },
      {
        heading: "5. Third-party services",
        blocks: [
          {
            p: "Shiori relies on a small number of third parties for distribution and updates, and a few optional features reach the web. Each third party is governed by its own privacy policy:",
          },
          {
            list: [
              "App distribution — when you install or update Shiori through the Apple App Store, Google Play, GitHub Releases, or the download links on our website, that platform or hosting provider handles the download request under its own privacy policy.",
              "Update checks — desktop builds fetch a small update file from updates.shiori.nagi.fun, a site hosted on GitHub Pages, a few seconds after each launch and whenever you choose Check for updates. When an update is offered, the app also fetches its release notes from the same site, and if you install it, the update downloads from GitHub Releases. Android builds installed from our APK ask shiori.nagi.fun (served by Cloudflare, which looks up the latest release on GitHub) and download updates from GitHub Releases. Builds from Google Play and the App Store, and the web version, make no update checks of their own. Each check is an ordinary HTTPS request: the server sees your IP address and basic request details such as the user agent, and nothing about your documents is sent.",
              "Links — the feedback board (https://tryshiori.featurebase.app, run by Featurebase), our website, GitHub, Discord and the sponsorship pages open in your browser only when you click them. Whatever you post or do there is governed by that site's own policy.",
              "Browser panel — on desktop and tablets, the optional Browser panel loads the pages you open in it, such as links you follow from a document, and those sites receive what any browser would send them. Text typed into its address bar that is not a web address is sent to Google as a search. With Keep browser logins on (the default), those sites' cookies and data stay on your device; turn it off for a temporary session.",
              "Remote images — Markdown and HTML documents can point to images and other files hosted on the web. Shiori does not load them unless you allow it for that document (or, for images, set Remote images to Always in Settings); once loaded, each file's host sees your IP address.",
              "Fonts on this website — this website loads its fonts from Google Fonts, so Google receives your IP address and basic request details when you view it. The apps and the web version carry their own fonts.",
              "Community — our Discord server is optional. If you join, your use of Discord is subject to Discord's privacy policy.",
            ],
          },
        ],
      },
      {
        heading: "6. Permissions",
        blocks: [
          {
            p: "Shiori only requests the access it needs to open and save documents you explicitly choose. On mobile, this means access to files you pick through the system document picker. Shiori does not request access to your contacts, location, photos library, microphone, or camera.",
          },
        ],
      },
      {
        heading: "7. Children's privacy",
        blocks: [
          {
            p: "Shiori is not directed at children under 13, and we do not knowingly collect personal information from anyone. Because Shiori does not collect personal data at all, no special handling of children's data is required.",
          },
        ],
      },
      {
        heading: "8. Your rights and choices",
        blocks: [
          {
            p: "Because your data never leaves your device, you remain in full control of it. You can export, back up, or permanently delete all of your Shiori data at any time by managing the folders described in section 3; on iOS and Android, uninstalling the app also deletes it. There is no account to close and no server-side data for us to delete on your behalf.",
          },
        ],
      },
      {
        heading: "9. Changes to this policy",
        blocks: [
          {
            p: "If we change this policy, we will update the date at the top of this page and, where appropriate, note the change in the app's release notes. Continued use of Shiori after an update means you accept the revised policy.",
          },
        ],
      },
      {
        heading: "10. Contact",
        blocks: [
          {
            p: `If you have any questions about this policy or your privacy, email us at ${CONTACT_EMAIL}. We read every message.`,
          },
        ],
      },
    ],
  },

  zh: {
    kicker: "隐私政策",
    title: "隐私政策",
    updatedLabel: "最后更新",
    intro:
      "Shiori 栞 是一款本地优先的文档阅读与 PDF 编辑工具，支持 macOS、Windows、Linux、iOS 与 Android。它的设计目标，就是让你的文档与工作始终留在你自己的设备上。本政策用直白的语言说明 Shiori 会、以及不会处理哪些数据。",
    sections: [
      {
        heading: "1. 概述",
        blocks: [
          {
            p: "Shiori 没有用户账号，没有存储你内容的服务器，也没有广告。桌面版与移动版不含任何分析统计；在线版只统计匿名访问量（见第 4 条）。我们不收集、不出售、不共享个人信息。一句话：你的文件是你的，并且只留在你的设备上。",
          },
        ],
      },
      {
        heading: "2. 我们不收集的信息",
        blocks: [
          {
            p: "使用 Shiori 无需注册或登录。我们不会收集以下任何内容：",
          },
          {
            list: [
              "姓名、电子邮箱或联系方式（除非你主动给我们发邮件——见第 10 条）。",
              "你打开的 PDF、Markdown 或 HTML 文档内容，或你所做的批注。",
              "桌面版与移动版中的使用分析、行为追踪，或任何形式的遥测。在线版只统计匿名访问量，详见第 4 条。",
              "广告标识符、位置信息、通讯录、相册、麦克风或相机权限。",
            ],
          },
        ],
      },
      {
        heading: "3. 数据存储的位置",
        blocks: [
          {
            p: "Shiori 生成的一切都写入你自己设备上的本地存储，绝不上传到我们的服务器。这包括你打开的文档、你做的批注、最近打开列表、主题与语言偏好、桌面端的一份简短错误日志，以及——如果你使用浏览器面板——你在其中访问的网页的 cookie 与站点数据。",
          },
          {
            p: "在桌面端，这些数据位于以 Shiori 的应用 ID fun.nagi.shiori 命名的文件夹中：macOS 上在 ~/Library/WebKit、~/Library/Application Support、~/Library/Caches 与 ~/Library/Logs 之下（另有文件 ~/Library/Preferences/fun.nagi.shiori.plist）；Windows 上在 %LOCALAPPDATA% 与 %APPDATA% 之下；Linux 上在 ~/.local/share、~/.config 与 ~/.cache 之下。在线版的数据位于你的浏览器为 app.shiori.nagi.fun 保存的站点存储中。在 iOS 与 Android 上，则位于由操作系统管理的应用私有沙盒内。你可以随时备份、复制或删除这些数据。在 iOS 与 Android 上卸载应用会将其删除；在桌面端，卸载通常不会删除这些文件夹，如需彻底清除，请自行删除它们。在线版请在浏览器中清除 app.shiori.nagi.fun 的站点数据。",
          },
        ],
      },
      {
        heading: "4. 关于本网站与在线版",
        blocks: [
          {
            p: "当你的浏览器从我们的静态托管服务 Cloudflare 加载本网站或 Shiori 在线版（https://app.shiori.nagi.fun）时，托管服务会收到你的 IP 地址和基本请求信息——这与你访问任何网站时的情形相同。这些信息仅用于呈现页面和防范滥用。两者都不放置广告，本网站也不含任何统计或追踪脚本。",
          },
          {
            p: "在线版使用 Cloudflare Web Analytics 统计汇总的访问量：页面浏览次数、来源网站、国家和浏览器类型。它不使用 cookie，不做指纹识别，不识别任何个人访客，也接触不到你的文档——文档完全在你的浏览器内打开和处理。",
          },
        ],
      },
      {
        heading: "5. 第三方服务",
        blocks: [
          {
            p: "Shiori 在分发与更新环节依赖少数几个第三方，另有几项可选功能会访问网络。各第三方受其自身隐私政策约束：",
          },
          {
            list: [
              "应用分发——当你通过 Apple App Store、Google Play、GitHub Releases 或本网站下载链接安装或更新 Shiori 时，由相应平台或托管服务处理下载请求，受其自身隐私政策约束。",
              "更新检查——桌面版会在每次启动几秒后、以及你选择「检查更新」时，从托管于 GitHub Pages 的 updates.shiori.nagi.fun 获取一个很小的更新文件。有可用更新时，应用还会从同一站点获取更新说明；如果你选择安装，更新包从 GitHub Releases 下载。通过我们的 APK 安装的 Android 版会向 shiori.nagi.fun 查询（由 Cloudflare 提供服务，它会向 GitHub 查询最新版本），并从 GitHub Releases 下载更新。Google Play 与 App Store 版本以及在线版自身不做任何更新检查。每次检查都是一次普通的 HTTPS 请求：服务器能看到你的 IP 地址和 user agent 等基本请求信息，不会发送任何与你的文档有关的内容。",
              "链接——反馈板（https://tryshiori.featurebase.app，由 Featurebase 运营）、我们的网站、GitHub、Discord 以及赞助页面，只有在你点击时才会在浏览器中打开。你在这些网站上发布或进行的任何操作，受该网站自身政策约束。",
              "浏览器面板——在桌面端与平板上，可选的浏览器面板会加载你在其中打开的网页，例如你从文档中点开的链接；这些网站收到的信息与任何浏览器发送的相同。在地址栏中输入的非网址文字会作为搜索词发送给 Google。开启「保留浏览器登录状态」（默认开启）时，这些网站的 cookie 与数据保存在你的设备上；关闭后则为临时会话。",
              "远程图片——Markdown 与 HTML 文档可以引用网络上的图片及其他文件。除非你为该文档允许加载（对图片而言，也可以在设置中将「远程图片」设为「始终」），Shiori 不会加载它们；一旦加载，每个文件的托管方都能看到你的 IP 地址。",
              "本网站的字体——本网站从 Google Fonts 加载字体，因此你浏览本网站时 Google 会收到你的 IP 地址和基本请求信息。各应用与在线版使用自带的字体。",
              "社群——我们的 Discord 服务器是可选的。若你加入，你对 Discord 的使用受 Discord 隐私政策约束。",
            ],
          },
        ],
      },
      {
        heading: "6. 权限",
        blocks: [
          {
            p: "Shiori 只申请打开与保存你主动选择的文档所需的权限。在移动端，这意味着访问你通过系统文档选择器挑选的文件。Shiori 不会申请你的通讯录、位置、相册、麦克风或相机权限。",
          },
        ],
      },
      {
        heading: "7. 儿童隐私",
        blocks: [
          {
            p: "Shiori 并非面向 13 岁以下的儿童，我们也不会在知情的情况下收集任何人的个人信息。由于 Shiori 根本不收集个人数据，因此无需对儿童数据做特殊处理。",
          },
        ],
      },
      {
        heading: "8. 你的权利与选择",
        blocks: [
          {
            p: "由于你的数据从不离开设备，你始终对其拥有完全的控制权。你可以随时通过管理第 3 条所述的文件夹，来导出、备份或永久删除你全部的 Shiori 数据；在 iOS 与 Android 上，卸载应用也会将其删除。没有需要注销的账号，我们也没有任何服务器端数据可代你删除。",
          },
        ],
      },
      {
        heading: "9. 政策的变更",
        blocks: [
          {
            p: "如果我们修改本政策，会更新本页顶部的日期，并在适当情况下于应用的更新说明中加以注明。在政策更新后继续使用 Shiori，即表示你接受修订后的政策。",
          },
        ],
      },
      {
        heading: "10. 联系我们",
        blocks: [
          {
            p: `如对本政策或你的隐私有任何疑问，请发邮件至 ${CONTACT_EMAIL}。我们会阅读每一封来信。`,
          },
        ],
      },
    ],
  },

  ja: {
    kicker: "プライバシーポリシー",
    title: "プライバシーポリシー",
    updatedLabel: "最終更新",
    intro:
      "Shiori 栞 は、macOS・Windows・Linux・iOS・Android に対応した、ローカルファーストの文書リーダー兼 PDF エディターです。あなたの文書と作業が、あなた自身の端末の中にとどまるよう設計されています。本ポリシーでは、Shiori が扱うデータと扱わないデータを、わかりやすい言葉で説明します。",
    sections: [
      {
        heading: "1. 概要",
        blocks: [
          {
            p: "Shiori にはユーザーアカウントも、あなたのコンテンツを保存するサーバーも、広告もありません。デスクトップ版とモバイル版には解析機能が一切なく、ウェブ版は匿名の訪問数のみを集計します（第 4 項）。個人情報を収集・販売・共有することはありません。ひとことで言えば、あなたのファイルはあなたのものであり、あなたの端末の中にとどまります。",
          },
        ],
      },
      {
        heading: "2. 収集しない情報",
        blocks: [
          {
            p: "Shiori の利用にアカウント登録やサインインは不要です。以下のいずれも収集しません：",
          },
          {
            list: [
              "氏名、メールアドレス、連絡先（あなたが自らメールを送る場合を除く — 第 10 項参照）。",
              "あなたが開く PDF、Markdown、HTML 文書の内容や、付け加えた注釈。",
              "デスクトップ版とモバイル版における利用解析、行動トラッキング、あらゆる種類のテレメトリ。ウェブ版は匿名の訪問数のみを集計します（第 4 項参照）。",
              "広告識別子、位置情報、連絡先、写真、マイク、カメラへのアクセス。",
            ],
          },
        ],
      },
      {
        heading: "3. データの保存場所",
        blocks: [
          {
            p: "Shiori が作成するものはすべて、あなた自身の端末のローカルストレージに書き込まれ、私たちのサーバーに送られることはありません。これには、開いた文書、付けた注釈、最近開いたリスト、テーマと言語の設定、デスクトップ版の短いエラーログ、そしてブラウザパネルを使う場合はそこで訪れたページの Cookie とサイトデータが含まれます。",
          },
          {
            p: "デスクトップでは、Shiori のアプリ ID fun.nagi.shiori の名前が付いたフォルダに保存されます：macOS では ~/Library/WebKit、~/Library/Application Support、~/Library/Caches、~/Library/Logs の中（加えてファイル ~/Library/Preferences/fun.nagi.shiori.plist）、Windows では %LOCALAPPDATA% と %APPDATA% の中、Linux では ~/.local/share、~/.config、~/.cache の中です。ウェブ版では、ブラウザが app.shiori.nagi.fun 用に保持するサイトストレージに保存されます。iOS と Android では、OS が管理するアプリ専用のサンドボックス内に保存されます。これらのデータはいつでもバックアップ・複製・削除できます。iOS と Android ではアプリをアンインストールすると削除されますが、デスクトップではアンインストールしてもこれらのフォルダは通常残るため、すべて消去するにはご自身で削除してください。ウェブ版では、ブラウザで app.shiori.nagi.fun のサイトデータを消去してください。",
          },
        ],
      },
      {
        heading: "4. 本ウェブサイトとウェブ版について",
        blocks: [
          {
            p: "ブラウザが静的ホスティング事業者 Cloudflare から本サイトまたは Shiori のウェブ版（https://app.shiori.nagi.fun）を読み込む際、どのウェブサイトでも同様に、事業者はあなたの IP アドレスと基本的なリクエスト情報を受け取ります。これはページの配信と不正利用の防止のためにのみ使われます。いずれにも広告は設置しておらず、本サイトには解析やトラッキングのスクリプトもありません。",
          },
          {
            p: "ウェブ版では Cloudflare Web Analytics を使い、訪問数を集計値として把握しています：ページビュー、参照元サイト、国、ブラウザの種類です。Cookie は使わず、フィンガープリントによる識別も行わず、個々の訪問者を特定しません。文書はすべてブラウザ内で開かれ処理されるため、あなたの文書に触れることもありません。",
          },
        ],
      },
      {
        heading: "5. 第三者サービス",
        blocks: [
          {
            p: "Shiori は配布と更新のために、ごく少数の第三者を利用します。また、いくつかの任意の機能はウェブにアクセスします。各第三者はそれぞれ独自のプライバシーポリシーに従います：",
          },
          {
            list: [
              "アプリ配布 — Apple App Store、Google Play、GitHub Releases、または当サイトのダウンロードリンクから Shiori をインストール・更新する場合、そのプラットフォームまたはホスティング事業者がダウンロードリクエストを、それぞれのプライバシーポリシーに従って扱います。",
              "更新確認 — デスクトップ版は、起動のたびに数秒後と「アップデートを確認」を選んだときに、GitHub Pages でホストされている updates.shiori.nagi.fun から小さな更新ファイルを取得します。更新がある場合は同じサイトからリリースノートも取得し、インストールを選ぶと更新は GitHub Releases からダウンロードされます。当サイトの APK からインストールした Android 版は shiori.nagi.fun（Cloudflare が配信し、GitHub に最新リリースを問い合わせます）に問い合わせ、更新を GitHub Releases からダウンロードします。Google Play 版と App Store 版、およびウェブ版は、独自の更新確認を行いません。いずれの確認も通常の HTTPS リクエストで、サーバーには IP アドレスとユーザーエージェントなどの基本的なリクエスト情報が届きますが、文書に関する情報は一切送信しません。",
              "リンク — フィードバックボード（https://tryshiori.featurebase.app、Featurebase が運営）、当サイト、GitHub、Discord、支援ページは、クリックしたときにだけブラウザで開きます。そこでの投稿や操作は、各サイトのポリシーに従います。",
              "ブラウザパネル — デスクトップとタブレットでは、任意のブラウザパネルがそこで開いたページ（文書内のリンクなど）を読み込み、各サイトには通常のブラウザと同じ情報が届きます。アドレスバーに入力したウェブアドレスでない文字列は、検索語として Google に送られます。「ブラウザのログインを保持」がオン（既定）の場合、それらのサイトの Cookie とデータは端末に保存されます。オフにすると一時的なセッションになります。",
              "リモート画像 — Markdown や HTML の文書は、ウェブ上の画像やその他のファイルを参照できます。その文書で読み込みを許可しない限り（画像については、設定で「リモート画像」を「常に許可」にした場合も含む）、Shiori はそれらを読み込みません。読み込むと、各ファイルのホストにあなたの IP アドレスが知られます。",
              "本サイトのフォント — 本サイトは Google Fonts からフォントを読み込むため、閲覧時に Google があなたの IP アドレスと基本的なリクエスト情報を受け取ります。各アプリとウェブ版は独自にフォントを同梱しています。",
              "コミュニティ — 私たちの Discord サーバーは任意です。参加する場合、あなたの Discord 利用は Discord のプライバシーポリシーに従います。",
            ],
          },
        ],
      },
      {
        heading: "6. 権限",
        blocks: [
          {
            p: "Shiori は、あなたが自ら選んだ文書を開いて保存するために必要な権限のみを要求します。モバイルでは、システムの書類ピッカーで選んだファイルへのアクセスを意味します。連絡先、位置情報、写真ライブラリ、マイク、カメラへのアクセスは要求しません。",
          },
        ],
      },
      {
        heading: "7. 子どものプライバシー",
        blocks: [
          {
            p: "Shiori は 13 歳未満の子どもを対象としておらず、いかなる人物の個人情報も故意に収集することはありません。そもそも Shiori は個人データを一切収集しないため、子どものデータに対する特別な取り扱いは必要ありません。",
          },
        ],
      },
      {
        heading: "8. あなたの権利と選択",
        blocks: [
          {
            p: "あなたのデータは端末を離れないため、あなたが常に完全な管理権を持ちます。第 3 項に記載のフォルダを操作することで、Shiori のすべてのデータをいつでも書き出し・バックアップ・完全削除できます。iOS と Android では、アプリをアンインストールしても削除されます。解約すべきアカウントはなく、私たちが代わりに削除すべきサーバー側のデータもありません。",
          },
        ],
      },
      {
        heading: "9. 本ポリシーの変更",
        blocks: [
          {
            p: "本ポリシーを変更する場合、本ページ上部の日付を更新し、必要に応じてアプリのリリースノートでも告知します。更新後に Shiori を使い続けることは、改訂後のポリシーに同意したものとみなされます。",
          },
        ],
      },
      {
        heading: "10. お問い合わせ",
        blocks: [
          {
            p: `本ポリシーやプライバシーについてご質問があれば、${CONTACT_EMAIL} までメールでお寄せください。すべてのメッセージに目を通しています。`,
          },
        ],
      },
    ],
  },
};

export const SUPPORT_DOC: Record<Lang, LegalDoc> = {
  en: {
    kicker: "Support",
    title: "Support",
    updatedLabel: "Last updated",
    intro:
      "Need a hand with Shiori? This page covers how to reach us, the most common questions, and the practical details about updates, limits, and your data.",
    sections: [
      {
        heading: "Contact us",
        blocks: [
          {
            p: `The fastest way to reach us is email: ${CONTACT_EMAIL}. We read every message. You can also join our community on Discord at https://discord.gg/G5uzmAaHY, or report issues on GitHub at https://github.com/Nagi-ovo/shiori/issues.`,
          },
        ],
      },
      {
        heading: "Reporting a bug",
        blocks: [
          {
            p: "If something isn't working, the most helpful report includes your operating system and version, the Shiori version (shown in Settings → About), and the steps that led to the problem. Send it by email or open a GitHub issue and we'll take a look.",
          },
        ],
      },
      {
        heading: "Supported platforms",
        blocks: [
          {
            p: "Shiori runs on macOS, Windows, and Linux as a desktop app, on Android through both Google Play and a direct APK, and on iOS / iPadOS as one universal iPhone + iPad app. Downloads are listed on our website and GitHub Releases; store builds are distributed through the Apple App Store and Google Play as they become available.",
          },
        ],
      },
      {
        heading: "Beta limitations",
        blocks: [
          {
            p: "Shiori is currently in beta. During the beta, individual files are capped at 200 MB and 500 pages. If something changes between beta releases, simply update to the latest version to continue.",
          },
        ],
      },
      {
        heading: "Updates and uninstalling",
        blocks: [
          {
            p: "Desktop builds check for a newer release on launch and update in place once you approve. Store-installed mobile apps update through the App Store or Google Play. Direct Android APK builds are delivered from our download page and GitHub Releases, with any direct-update flow shown separately inside the app when available. To uninstall, remove the app the usual way for your platform — see the Privacy Policy for where your local data lives if you also want to delete that.",
          },
        ],
      },
      {
        heading: "Your data and privacy",
        blocks: [
          {
            p: "Shiori keeps your documents and annotations on your own device and collects no personal data. For the full picture, see our Privacy Policy at https://shiori.nagi.fun/#/privacy.",
          },
        ],
      },
    ],
  },

  zh: {
    kicker: "支持",
    title: "支持",
    updatedLabel: "最后更新",
    intro:
      "使用 Shiori 时需要帮助？本页面介绍如何联系我们、最常见的问题，以及关于更新、限制和你的数据的实用说明。",
    sections: [
      {
        heading: "联系我们",
        blocks: [
          {
            p: `找我们最快的方式是电子邮件：${CONTACT_EMAIL}。我们会阅读每一封来信。你也可以加入我们的 Discord 社群 https://discord.gg/G5uzmAaHY，或在 GitHub 上报告问题 https://github.com/Nagi-ovo/shiori/issues。`,
          },
        ],
      },
      {
        heading: "报告问题",
        blocks: [
          {
            p: "如果某项功能无法正常工作，最有帮助的报告应包含你的操作系统及版本、Shiori 的版本号（见「设置 → 关于」），以及导致问题的操作步骤。通过邮件发给我们，或在 GitHub 上提一个 issue，我们会查看。",
          },
        ],
      },
      {
        heading: "支持的平台",
        blocks: [
          {
            p: "Shiori 提供 macOS、Windows、Linux 桌面应用；Android 同时提供 Google Play 版与直接安装 APK；iOS / iPadOS 则是同一个同时支持 iPhone 与 iPad 的应用。官网和 GitHub Releases 会列出可下载版本；通过审核后的商店版本则由 Apple App Store 与 Google Play 分发。",
          },
        ],
      },
      {
        heading: "公测限制",
        blocks: [
          {
            p: "Shiori 目前处于公测阶段。公测期间，单个文件上限为 200 MB / 500 页。若公测版本之间有行为变化，只需更新到最新版本即可继续使用。",
          },
        ],
      },
      {
        heading: "更新与卸载",
        blocks: [
          {
            p: "桌面版会在启动时检查是否有新版本，并在你确认后原地更新。通过商店安装的移动版由 App Store 或 Google Play 更新。直接安装的 Android APK 由官网和 GitHub Releases 分发；如果后续提供直接更新，会在应用内单独显示。卸载时，按你所在平台的常规方式移除应用即可——如果你还想删除本地数据，请参阅隐私政策了解其存放位置。",
          },
        ],
      },
      {
        heading: "你的数据与隐私",
        blocks: [
          {
            p: "Shiori 将你的文档与批注保留在你自己的设备上，不收集任何个人数据。完整说明请见我们的隐私政策 https://shiori.nagi.fun/#/privacy。",
          },
        ],
      },
    ],
  },

  ja: {
    kicker: "サポート",
    title: "サポート",
    updatedLabel: "最終更新",
    intro:
      "Shiori でお困りですか？このページでは、お問い合わせ方法、よくある質問、そしてアップデート・制限・データに関する実用的な情報をまとめています。",
    sections: [
      {
        heading: "お問い合わせ",
        blocks: [
          {
            p: `いちばん早いのはメールです：${CONTACT_EMAIL}。すべてのメッセージに目を通しています。Discord コミュニティ https://discord.gg/G5uzmAaHY への参加や、GitHub での不具合報告 https://github.com/Nagi-ovo/shiori/issues もできます。`,
          },
        ],
      },
      {
        heading: "不具合の報告",
        blocks: [
          {
            p: "うまく動かないときは、お使いの OS とそのバージョン、Shiori のバージョン（「設定 → アプリについて」に表示）、そして問題に至った操作手順を添えていただけると助かります。メールでお送りいただくか、GitHub に issue を立ててください。確認いたします。",
          },
        ],
      },
      {
        heading: "対応プラットフォーム",
        blocks: [
          {
            p: "Shiori は macOS・Windows・Linux のデスクトップアプリ、Android の Google Play 版と直接インストール用 APK、そして iPhone と iPad の両方に対応する単一の iOS / iPadOS アプリとして動作します。ダウンロードは当サイトと GitHub Releases に掲載し、ストア版は利用可能になり次第 Apple App Store と Google Play から配布されます。",
          },
        ],
      },
      {
        heading: "ベータ版の制限",
        blocks: [
          {
            p: "Shiori は現在ベータ版です。ベータ期間中は 1 ファイルあたり 200 MB・500 ページまでです。ベータリリース間で動作が変わった場合は、最新版に更新すれば使い続けられます。",
          },
        ],
      },
      {
        heading: "アップデートとアンインストール",
        blocks: [
          {
            p: "デスクトップ版は起動時に新バージョンを確認し、承認するとその場で更新します。ストアからインストールしたモバイル版は App Store または Google Play から更新されます。直接インストール用 Android APK は当サイトと GitHub Releases から配布し、直接更新フローを提供する場合はアプリ内で別途表示します。アンインストールは各プラットフォームの通常の方法でアプリを削除してください。ローカルデータも削除したい場合は、その保存場所についてプライバシーポリシーをご覧ください。",
          },
        ],
      },
      {
        heading: "データとプライバシー",
        blocks: [
          {
            p: "Shiori はあなたの文書と注釈をあなた自身の端末に保持し、個人データを一切収集しません。詳しくはプライバシーポリシー https://shiori.nagi.fun/#/privacy をご覧ください。",
          },
        ],
      },
    ],
  },
};
