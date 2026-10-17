// Public hand-authored diagnostic text and topic relevance; no private corpus.
export const embeddingTopics = [
  [
    "lease",
    "The tenant must notify the landlord three months before ending the rental agreement.",
    "L'inquilino deve avvisare il proprietario tre mesi prima di interrompere il contratto di affitto.",
    "Quanto preavviso serve per lasciare un appartamento in affitto?",
    "How early must a renter tell the owner they are leaving?",
    "За сколько времени арендатор должен предупредить о выезде?",
  ],
  [
    "password",
    "If you forget your account password, request a recovery link by email.",
    "Se dimentichi la password dell'account, richiedi un collegamento di recupero tramite email.",
    "Non ricordo le credenziali di accesso, come posso ripristinarle?",
    "I cannot remember my login secret. How do I regain access?",
    "忘记账户密码后如何恢复访问？",
  ],
  [
    "battery",
    "For longer battery life, reduce screen brightness and disable background applications.",
    "Per prolungare la durata della batteria, riduci la luminosità dello schermo e disattiva le applicazioni in background.",
    "Come faccio a usare meno energia sul portatile?",
    "How can I make my laptop last longer without charging?",
    "Как увеличить время работы ноутбука без зарядки?",
  ],
  [
    "refund",
    "Customers can return an unused product within thirty days to receive their money back.",
    "I clienti possono restituire un prodotto inutilizzato entro trenta giorni per ottenere il rimborso.",
    "Entro quando posso rendere un acquisto e recuperare i soldi?",
    "What is the deadline for sending back an unused purchase?",
    "未使用的商品可以在多少天内退货退款？",
  ],
  [
    "garden",
    "Tomato plants require regular watering and at least six hours of direct sunlight daily.",
    "Le piante di pomodoro richiedono irrigazione regolare e almeno sei ore di sole diretto al giorno.",
    "Di quanta luce e acqua hanno bisogno i pomodori?",
    "What growing conditions do tomatoes need?",
    "Сколько солнца и воды нужно помидорам?",
  ],
  [
    "train",
    "Passengers must validate their paper railway tickets before boarding the train.",
    "I passeggeri devono convalidare i biglietti ferroviari cartacei prima di salire sul treno.",
    "Quando va timbrato un biglietto cartaceo per viaggiare in ferrovia?",
    "Do I need to stamp my paper ticket before I get on board?",
    "纸质火车票应该在上车前检票吗？",
  ],
  [
    "backup",
    "Keep an encrypted backup on an external disk and test restoring files every month.",
    "Conserva una copia di sicurezza cifrata su un disco esterno e prova il ripristino dei file ogni mese.",
    "Come proteggere i documenti dalla perdita e verificare che siano recuperabili?",
    "How should I preserve files and check that recovery works?",
    "Как защитить файлы от потери и проверить восстановление?",
  ],
  [
    "bread",
    "Bread dough rises when yeast ferments sugars and produces carbon dioxide in a warm place.",
    "L'impasto del pane lievita quando il lievito fermenta gli zuccheri e produce anidride carbonica al caldo.",
    "Perché l'impasto aumenta di volume durante la preparazione del pane?",
    "What makes a loaf expand before baking?",
    "面包面团在烘烤前为什么会膨胀？",
  ],
];

// Added before provider evaluation; close-domain legal/technical distractors.
export const embeddingHoldout = [
  [
    "employment",
    "A worker resigning from a job must give the employer the notice period specified by the collective labour agreement. Notice depends on job grade and years of service.",
    "Il lavoratore che si dimette deve rispettare il preavviso previsto dal contratto collettivo. La durata dipende dal livello e dagli anni di servizio.",
    {
      it:
        "Mi dimetto dal lavoro: come determino il preavviso dovuto all'azienda?",
      en:
        "Which rules decide how long I must work after handing in my resignation?",
      ru: "Как определить срок уведомления работодателя при увольнении?",
      zh: "员工辞职需要提前多久通知雇主，依据什么规定？",
      ja: "退職するとき会社への予告期間は何によって決まりますか？",
    },
  ],
  [
    "credit-note",
    "When an invoice contains an incorrect amount, issue a credit note referencing the original invoice. The credit note adjusts the taxable amount and VAT; it is not a reminder to pay.",
    "Per correggere l'importo di una fattura si emette una nota di credito collegata al documento originale. La nota rettifica imponibile e IVA e non è un sollecito di pagamento.",
    {
      it:
        "Come rettifico una fattura con un importo sbagliato e la relativa IVA?",
      en: "What document corrects an overcharged invoice and its sales tax?",
      ru: "Каким документом исправить завышенную сумму счёта и налог?",
      zh: "发票金额开错了，应该用什么文件更正金额和税额？",
      ja: "請求書の金額と税額が間違っている場合はどの書類で訂正しますか？",
    },
  ],
  [
    "privacy-erasure",
    "A person may request erasure of personal information that no longer has a valid processing purpose. The controller must also consider legal retention duties before deleting it.",
    "L'interessato può chiedere la cancellazione dei dati personali quando manca uno scopo valido del trattamento. Prima di eliminarli il titolare verifica gli obblighi legali di conservazione.",
    {
      it:
        "Posso chiedere che i miei dati personali siano cancellati quando non servono più?",
      en:
        "Can I ask an organisation to erase personal records that it no longer needs?",
      ru:
        "Можно ли потребовать удаления персональных данных, которые больше не нужны?",
      zh: "机构不再需要我的个人资料时，我能要求删除吗？",
      ja: "組織が不要になった私の個人情報の削除を求められますか？",
    },
  ],
  [
    "appeal",
    "An appeal challenges a court decision before a higher court. The deadline is counted from service or publication according to the applicable procedural rule, not from the hearing reservation.",
    "L'impugnazione contesta una decisione del giudice davanti all'organo superiore. Il termine decorre dalla notifica o pubblicazione secondo la norma processuale, non dalla prenotazione dell'udienza.",
    {
      it: "Da quale evento parte il termine per impugnare una sentenza?",
      en: "What event starts the time limit for challenging a court judgment?",
      ru: "С какого события начинается срок обжалования судебного решения?",
      zh: "对法院判决提出上诉的期限从哪个事件开始计算？",
      ja: "裁判の判決に対する上訴期限は何を起点として計算しますか？",
    },
  ],
  [
    "pdf-text-layer",
    "A digital PDF can contain selectable native text. Extract that text without OCR. Scanned image-only pages need optical character recognition, while keeping their original page numbers for citations.",
    "Un PDF digitale può avere testo nativo selezionabile, da estrarre senza OCR. Le pagine costituite solo da scansioni richiedono riconoscimento ottico, mantenendo il numero di pagina per le citazioni.",
    {
      it:
        "Come distinguere le pagine PDF da leggere direttamente da quelle che richiedono riconoscimento ottico?",
      en:
        "When should a PDF parser read selectable text and when should it recognise scanned pages?",
      ru:
        "Когда извлекать текст PDF напрямую, а когда распознавать сканированные страницы?",
      zh: "PDF什么时候直接提取可选文字，什么时候需要识别扫描页面？",
      ja:
        "PDFの選択可能な文字を抽出する場合とスキャンを文字認識する場合をどう分けますか？",
    },
  ],
  [
    "file-dedup",
    "Use a full-file SHA-256 digest to identify identical content at different paths before extraction. Hashing extracted chunks separately reuses shared passage embeddings without merging file identities.",
    "L'hash SHA-256 dell'intero file identifica contenuti uguali in percorsi diversi prima dell'estrazione. Hash separati dei chunk riusano gli embedding dei passaggi comuni senza fondere l'identità dei file.",
    {
      it:
        "Come evitare di estrarre due volte file identici e riusare vettori di paragrafi comuni senza perdere i percorsi?",
      en:
        "How do file digests and passage hashes avoid duplicate extraction and vector work while preserving paths?",
      ru:
        "Как хеши файлов и фрагментов исключают повторную обработку, сохраняя отдельные пути?",
      zh: "如何用文件和段落哈希避免重复提取和向量计算，同时保留不同路径？",
      ja:
        "ファイルと段落のハッシュでパスを保持しながら重複した抽出とベクトル計算を防ぐには？",
    },
  ],
];
