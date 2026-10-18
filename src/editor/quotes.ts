// Landing-page quote rotation, one pool per display locale.
//
// Tone: aphoristic, slightly wry, contemplative, weary-but-fond. A quote
// admits the cost or paradox of long study without preaching; "study harder,
// succeed more" lines belong elsewhere. The register was set by the original
// placeholder, Ecclesiastes 12:12 ("much study is a weariness of the flesh").
//
// Keep in rotation: Saigyō's 栞-etymology poem (the brand anchor), and at
// least one of the cost-of-study entries (庄子 / Steiner / Seneca) so the
// original tone never disappears.

export type Quote = { text: string; attribution: string; gloss?: string };

export const QUOTES_EN: Quote[] = [
  {
    text: "There is no book so bad that some good cannot be got out of it.",
    attribution: "Pliny the Younger, Epistles 3.5",
  },
  {
    text: "Distringit librorum multitudo. (The abundance of books is a distraction.)",
    attribution: "Seneca, Epistles II",
  },
  {
    text: "Linger among a limited number of master-thinkers, and digest their works.",
    attribution: "Seneca, Epistles II",
  },
  {
    text: "Otium sine litteris mors est et hominis vivi sepultura. (Leisure without books is death — a living man's tomb.)",
    attribution: "Seneca, Epistles 82",
  },
  {
    text: "Numquam minus solus quam cum solus. (Never less alone than when alone.)",
    attribution: "Cicero, De Officiis 3.1",
  },
  {
    text: "These studies nourish youth, delight old age, adorn prosperity, give refuge in adversity.",
    attribution: "Cicero, Pro Archia 7.16",
  },
  {
    text: "I have friends whose society is delightful to me; they are persons of all countries and of all ages.",
    attribution: "Petrarch, Letters of Friendly Intercourse",
  },
  {
    text: "Books have led some to learning and others to madness, when they swallow more than they can digest.",
    attribution: "Petrarch",
  },
  {
    text: "When I have a little money, I buy books; and if I have any left, I buy food and clothes.",
    attribution: "Erasmus, letter to Jacob Batt, 1500",
  },
  {
    text: "I do nothing without gaiety; continuation and a too obstinate endeavor darkens, stupefies, and tires my judgment.",
    attribution: "Montaigne, Of Books",
  },
  {
    text: "Some books are to be tasted, others to be swallowed, and some few to be chewed and digested.",
    attribution: "Francis Bacon, Of Studies",
  },
  {
    text: "Studies serve for delight, for ornament, and for ability.",
    attribution: "Francis Bacon, Of Studies",
  },
  {
    text: "Knowledge is of two kinds. We know a subject ourselves, or we know where we can find information upon it.",
    attribution: "Samuel Johnson (in Boswell's Life)",
  },
  {
    text: "I love to lose myself in other men's minds. When I am not walking, I am reading; I cannot sit and think. Books think for me.",
    attribution: "Charles Lamb, Detached Thoughts on Books and Reading",
  },
  {
    text: "A book reads the better which is our own, and has been so long known to us that we know the topography of its blots and dog's-ears.",
    attribution: "Charles Lamb, Detached Thoughts on Books and Reading",
  },
  {
    text: "I hate to read new books.",
    attribution: "William Hazlitt, On Reading Old Books",
  },
  {
    text: "There are twenty or thirty volumes that I have read over and over again, and these are the only ones that I have any desire ever to read at all.",
    attribution: "William Hazlitt, On Reading Old Books",
  },
  {
    text: "'Tis the good reader that makes the good book.",
    attribution: "Ralph Waldo Emerson, Society and Solitude: Books",
  },
  {
    text: "The crowds and centuries of books are only commentary and elucidation — echoes and weakeners of these few great voices of Time.",
    attribution: "Ralph Waldo Emerson, Books",
  },
  {
    text: "A book, I value, I reason and quarrel with as with myself when I am reasoning.",
    attribution: "Samuel Taylor Coleridge, Marginalia",
  },
  {
    text: "These marginalia are deliberately pencilled, because the mind of the reader wishes to unburthen itself of a thought — however flippant, however silly, however trivial — still a thought indeed.",
    attribution: "Edgar Allan Poe, Marginalia",
  },
  {
    text: "Let others pride themselves about how many pages they have written; I'd rather boast about the ones I've read.",
    attribution: "Jorge Luis Borges",
  },
  {
    text: "I cannot sleep unless I am surrounded by books.",
    attribution: "Jorge Luis Borges",
  },
  {
    text: "I have always imagined that Paradise will be a kind of library.",
    attribution: "Jorge Luis Borges",
  },
  {
    text: "I feel, almost physically, the gravitation of the books, the enveloping serenity of order, time magically dessicated and preserved.",
    attribution: "Jorge Luis Borges",
  },
  {
    text: "Let heaven exist, though my own place be in hell. Let there be one instant, one creature, wherein thy enormous Library may find its justification.",
    attribution: "Jorge Luis Borges, The Library of Babel",
  },
  {
    text: "The Library will endure: illuminated, solitary, infinite, perfectly motionless, equipped with precious volumes, useless, incorruptible, secret.",
    attribution: "Jorge Luis Borges, The Library of Babel",
  },
  {
    text: "I am unpacking my library. The books are not yet on the shelves, not yet touched by the mild boredom of order.",
    attribution: "Walter Benjamin, Unpacking My Library",
  },
  {
    text: "Every passion borders on the chaotic, but the collector's passion borders on the chaos of memories.",
    attribution: "Walter Benjamin, Unpacking My Library",
  },
  {
    text: "How many cities have revealed themselves to me in the marches I undertook in the pursuit of books!",
    attribution: "Walter Benjamin, Unpacking My Library",
  },
  {
    text: "A classic is a book that has never finished saying what it has to say.",
    attribution: "Italo Calvino, Why Read the Classics?",
  },
  {
    text: "The classics are the books we usually hear people say, 'I am rereading…' and never 'I am reading.'",
    attribution: "Italo Calvino, Why Read the Classics?",
  },
  {
    text: "The moment that counts most for me is the one that precedes reading.",
    attribution: "Italo Calvino, If on a Winter's Night a Traveler",
  },
  {
    text: "Until then I had thought each book spoke of things outside books. Now I realized that, not infrequently, books speak of books.",
    attribution: "Umberto Eco, The Name of the Rose",
  },
  {
    text: "A book is a fragile creature, it suffers the wear of time, it fears rodents, the elements, clumsy hands.",
    attribution: "Umberto Eco, The Name of the Rose",
  },
  {
    text: "Books are not made to be believed, but to be subjected to inquiry.",
    attribution: "Umberto Eco, The Name of the Rose",
  },
  {
    text: "Read books are far less valuable than unread ones. The library should contain as much of what you do not know as your means allow you to put there.",
    attribution: "Nassim Nicholas Taleb, The Black Swan (on Eco's anti-library)",
  },
  {
    text: "At one magical instant in your early childhood, the page of a book shivered into meaning. You became, irrevocably, a reader.",
    attribution: "Alberto Manguel, A History of Reading",
  },
  {
    text: "Stories are our memory, libraries are the storerooms of that memory, and reading is the craft by means of which we can recreate that memory.",
    attribution: "Alberto Manguel, A History of Reading",
  },
  {
    text: "At night, when the library lamps are lit, the outside world disappears and nothing but the space of books remains in existence.",
    attribution: "Alberto Manguel, The Library at Night",
  },
  {
    text: "He is no true reader who has not experienced the reproachful fascination of the great shelves of unread books.",
    attribution: "George Steiner",
  },
  {
    text: "Books are in no hurry. An act of creation is in no hurry; it reads us, it privileges us infinitely.",
    attribution: "George Steiner",
  },
  {
    text: "The intellectual is, quite simply, a human being who has a pencil in his or her hand when reading a book.",
    attribution: "George Steiner",
  },
  {
    text: "My library is an archive of longings.",
    attribution: "Susan Sontag",
  },
  {
    text: "The time of reading is not the world's time, but the soul's.",
    attribution: "Sven Birkerts, The Gutenberg Elegies",
  },
  {
    text: "Curiously enough, one cannot read a book; one can only reread it. A good reader, a major reader, an active and creative reader is a rereader.",
    attribution: "Vladimir Nabokov, Lectures on Literature",
  },
  {
    text: "For the author, beautiful books may be called Conclusions; for the reader, Provocations. Our wisdom begins where the author's ends.",
    attribution: "Marcel Proust, On Reading",
  },
  {
    text: "Hard use was a sign not of disrespect but of intimacy.",
    attribution: "Anne Fadiman, Ex Libris",
  },
  {
    text: "Closing a book on a bookmark is like pressing the Stop button; leaving the book facedown, you've only pressed Pause.",
    attribution: "Anne Fadiman, Ex Libris",
  },
  {
    text: "Open an old paperback, spangled with marginalia in a handwriting you outgrew long ago, and memories will jump out with as much vigor as if you'd opened your old diary.",
    attribution: "Anne Fadiman, Ex Libris",
  },
  {
    text: "Marking a book is literally an expression of your differences or your agreements with the author. It is the highest respect you can pay him.",
    attribution: "Mortimer J. Adler, How to Read a Book",
  },
  {
    text: "Full ownership of a book only comes when you have made it a part of yourself, and the best way to make yourself a part of it is by writing in it.",
    attribution: "Mortimer J. Adler, How to Mark a Book",
  },
  {
    text: "Sometimes the notes are ferocious, skirmishes against the author / raging along the borders of every page / in tiny black script.",
    attribution: "Billy Collins, Marginalia",
  },
  {
    text: "We have all seized the white perimeter as our own / and reached for a pen if only to show / we did not just laze in an armchair turning pages; / we pressed a thought into the wayside.",
    attribution: "Billy Collins, Marginalia",
  },
  {
    text: "Vindica te tibi. (Reclaim yourself for yourself.)",
    attribution: "Seneca, Epistles 1",
  },
  {
    text: "No more arguing what a good man is. Be one.",
    attribution: "Marcus Aurelius, Meditations 10.16",
  },
  {
    text: "Do not be ashamed to be helped.",
    attribution: "Marcus Aurelius, Meditations 7.7",
  },
  {
    text: "Felix qui potuit rerum cognoscere causas. (Happy the one who has known the causes of things.)",
    attribution: "Virgil, Georgics 2.490",
  },
  {
    text: "Quaero, non doceo. (I am asking, not teaching.)",
    attribution: "Seneca, Epistles 117.33",
  },
];

export const QUOTES_ZH: Quote[] = [
  {
    text: "学而不思则罔，思而不学则殆。",
    attribution: "《论语·为政》",
  },
  {
    text: "学而时习之，不亦说乎。",
    attribution: "《论语·学而》",
  },
  {
    text: "知之为知之，不知为不知，是知也。",
    attribution: "《论语·为政》",
  },
  {
    text: "朝闻道，夕死可矣。",
    attribution: "《论语·里仁》",
  },
  {
    text: "吾生也有涯，而知也无涯。",
    attribution: "《庄子·养生主》",
  },
  {
    text: "以有涯随无涯，殆已。",
    attribution: "《庄子·养生主》",
  },
  {
    text: "得鱼而忘筌，得意而忘言。",
    attribution: "《庄子·外物》",
  },
  {
    text: "尽信书，则不如无书。",
    attribution: "《孟子·尽心下》",
  },
  {
    text: "为学日益，为道日损。",
    attribution: "老子《道德经》第四十八章",
  },
  {
    text: "知者不博，博者不知。",
    attribution: "老子《道德经》第八十一章",
  },
  {
    text: "绝学无忧。",
    attribution: "老子《道德经》第二十章",
  },
  {
    text: "大道甚夷，而民好径。",
    attribution: "老子《道德经》第五十三章",
  },
  {
    text: "好读书，不求甚解。",
    attribution: "陶渊明《五柳先生传》",
  },
  {
    text: "每有会意，便欣然忘食。",
    attribution: "陶渊明《五柳先生传》",
  },
  {
    text: "结庐在人境，而无车马喧。",
    attribution: "陶渊明《饮酒·其五》",
  },
  {
    text: "独坐幽篁里，弹琴复长啸。深林人不知，明月来相照。",
    attribution: "王维《竹里馆》",
  },
  {
    text: "吾心似秋月，碧潭清皎洁。无物堪比伦，教我如何说。",
    attribution: "寒山诗",
  },
  {
    text: "读书破万卷，下笔如有神。",
    attribution: "杜甫《奉赠韦左丞丈二十二韵》",
  },
  {
    text: "旧书不厌百回读，熟读深思子自知。",
    attribution: "苏轼《送安惇秀才失解西归》",
  },
  {
    text: "粗缯大布裹生涯，腹有诗书气自华。",
    attribution: "苏轼《和董传留别》",
  },
  {
    text: "退笔如山未足珍，读书万卷始通神。",
    attribution: "苏轼《柳氏二外甥求笔迹》",
  },
  {
    text: "纸上得来终觉浅，绝知此事要躬行。",
    attribution: "陆游《冬夜读书示子聿》",
  },
  {
    text: "古人学问无遗力，少壮工夫老始成。",
    attribution: "陆游《冬夜读书示子聿》",
  },
  {
    text: "读书有味身忘老，病须书卷作良医。",
    attribution: "陆游《不寐》",
  },
  {
    text: "闲坐小窗读周易，不知春去几多时。",
    attribution: "叶采《暮春即事》",
  },
  {
    text: "问渠那得清如许，为有源头活水来。",
    attribution: "朱熹《观书有感》",
  },
  {
    text: "读书百遍，其义自见。",
    attribution: "《三国志》裴松之注引《魏略》",
  },
  {
    text: "立身以立学为先，立学以读书为本。",
    attribution: "欧阳修",
  },
  {
    text: "三日不读书，便觉语言无味，面目可憎。",
    attribution: "黄庭坚",
  },
  {
    text: "积财千万，无过读书。",
    attribution: "颜之推《颜氏家训·勉学》",
  },
  {
    text: "观天下书未遍，不得妄下雌黄。",
    attribution: "颜之推《颜氏家训·勉学》",
  },
  {
    text: "黑发不知勤学早，白首方悔读书迟。",
    attribution: "颜真卿《劝学》",
  },
  {
    text: "读未见书，如得良友；见已读书，如逢故人。",
    attribution: "张潮《幽梦影》",
  },
  {
    text: "藏书不难，能看为难；看书不难，能读为难。",
    attribution: "张潮《幽梦影》",
  },
  {
    text: "闭门即是深山，读书随处净土。",
    attribution: "陈继儒《小窗幽记》",
  },
  {
    text: "雪夜闭门读禁书。",
    attribution: "金圣叹《不亦快哉》",
  },
  {
    text: "蠹鱼三食神仙字，白首难成一卷书。",
    attribution: "陆龟蒙《杂讽》",
  },
  {
    text: "遥思往事，忆即书之，持向佛前，一一忏悔。",
    attribution: "张岱《陶庵梦忆·序》",
  },
  {
    text: "翻开书面就闯进大门，翻过几页就升堂入室。",
    attribution: "杨绛《读书苦乐》",
  },
  {
    text: "读书好比串门儿——隐身的串门儿。",
    attribution: "杨绛《读书苦乐》",
  },
  {
    text: "不必事前打招呼求见，也不怕搅扰主人。",
    attribution: "杨绛《读书苦乐》",
  },
  {
    text: "你的问题主要在于读书不多而想得太多。",
    attribution: "杨绛",
  },
  {
    text: "我们一大半作者只能算是书评家。",
    attribution: "钱钟书《写在人生边上》",
  },
  {
    text: "把忍受变成享受，是精神对于物质的大胜利。",
    attribution: "钱钟书《论快乐》",
  },
  {
    text: "一切情感、理智和意志上的追求，不过是灵魂的思家病。",
    attribution: "钱钟书《写在人生边上》",
  },
  {
    text: "读书使人得到一种优雅和风味。",
    attribution: "林语堂《生活的艺术》",
  },
  {
    text: "世上无人人必读的书。",
    attribution: "林语堂《生活的艺术》",
  },
  {
    text: "读书和婚姻一样，是命运注定的。",
    attribution: "林语堂《生活的艺术》",
  },
  {
    text: "凡是值得读的书至少须读两遍。",
    attribution: "朱光潜《给青年的十二封信》",
  },
  {
    text: "别的事都可以学时髦，唯有读书做学问不能学时髦。",
    attribution: "朱光潜《给青年的十二封信》",
  },
  {
    text: "我活在世上，无非想要明白些道理，遇见些有趣的事。",
    attribution: "王小波《沉默的大多数》",
  },
  {
    text: "所谓读书，就是与精神上素未谋面的人谈论人生。",
    attribution: "蒋勋",
  },
  {
    text: "生命的意义本不在向外的寻取，而在向内的建立。",
    attribution: "史铁生《病隙碎笔》",
  },
  {
    text: "我读书的秘诀是：看书中的那个人，不看他的主义。",
    attribution: "木心《文学回忆录》",
  },
  {
    text: "我是旧派的人，窗竹摇影、野泉滴砚的少年光景挥之未去。",
    attribution: "董桥《旧时月色》",
  },
];

export const QUOTES_JA: Quote[] = [
  {
    text: "月日は百代の過客にして、行きかふ年もまた旅人なり。",
    attribution: "松尾芭蕉『奥の細道』",
  },
  {
    text: "つれづれなるままに、日くらし、硯にむかひて。",
    attribution: "吉田兼好『徒然草』序段",
  },
  {
    text: "春はあけぼの。やうやう白くなりゆく山ぎは。",
    attribution: "清少納言『枕草子』第一段",
  },
  {
    text: "ゆく河の流れは絶えずして、しかももとの水にあらず。",
    attribution: "鴨長明『方丈記』冒頭",
  },
  // Brand anchor: Saigyo's 栞-etymology poem; keep permanently in rotation.
  {
    text: "吉野山去年のしをりの道かへてまだ見ぬかたの花を尋ねむ",
    attribution: "西行 (12世紀) — 「栞」の語源歌",
  },
  {
    text: "文は、見し書、見し物の、また見るほどに、その折おぼえらるる、あはれなり。",
    attribution: "清少納言『枕草子』",
  },
  {
    text: "学問に王道なし。",
    attribution: "ことわざ",
  },
  {
    text: "読書百遍、義自ずから見る。",
    attribution: "ことわざ（『三国志・魏志』由来）",
  },
  {
    text: "蛍雪の功。",
    attribution: "故事成語（『晋書』）",
  },
  {
    text: "灯火親しむべし。",
    attribution: "韓愈（受容）",
  },
  {
    text: "一日読まざれば、口中茨を生ず。",
    attribution: "ことわざ",
  },
  {
    text: "旅に病んで夢は枯野をかけ廻る",
    attribution: "松尾芭蕉 辞世",
  },
  {
    text: "やがて死ぬけしきは見えず蝉の声",
    attribution: "松尾芭蕉",
  },
  {
    text: "物言えば唇寒し秋の風",
    attribution: "松尾芭蕉",
  },
  {
    text: "行く春や鳥啼き魚の目は泪",
    attribution: "松尾芭蕉『奥の細道』",
  },
  {
    text: "焚くほどは風が持て来る落葉かな",
    attribution: "良寛",
  },
  {
    text: "裏を見せ表を見せて散る紅葉",
    attribution: "良寛 辞世",
  },
  {
    text: "智に働けば角が立つ。情に棹させば流される。",
    attribution: "夏目漱石『草枕』冒頭",
  },
  {
    text: "とかくに人の世は住みにくい。",
    attribution: "夏目漱石『草枕』",
  },
  {
    text: "国境の長いトンネルを抜けると雪国であった。",
    attribution: "川端康成『雪国』冒頭",
  },
  {
    text: "美しい日本の私。",
    attribution: "川端康成 ノーベル賞講演題",
  },
  {
    text: "書を捨てよ、町へ出よう。",
    attribution: "寺山修司",
  },
  {
    text: "経巻の文字を見るとき、即ち自己の眼睛を見る。",
    attribution: "道元『正法眼蔵・看経』",
  },
  {
    text: "学道の人は、後日を待ちて行ぜんと思ふこと莫れ。",
    attribution: "道元『正法眼蔵随聞記』",
  },
  {
    text: "学道の最要は坐禅是第一なり。",
    attribution: "道元『正法眼蔵随聞記』",
  },
];

const FALLBACK_QUOTE: Quote = {
  text: "There is no book so bad that some good cannot be got out of it.",
  attribution: "Pliny the Younger, Epistles 3.5",
};

export function getQuotePool(language?: string): Quote[] {
  const base = language?.split("-")[0];
  if (base === "zh") return QUOTES_ZH;
  if (base === "ja") return QUOTES_JA;
  return QUOTES_EN;
}

export function randomQuoteForLanguage(language?: string): Quote {
  const pool = getQuotePool(language);
  return pool[Math.floor(Math.random() * pool.length)] ?? FALLBACK_QUOTE;
}
