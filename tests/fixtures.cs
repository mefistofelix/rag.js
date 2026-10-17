using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Speech.Synthesis;
using System.Web.Script.Serialization;

public static class Fixtures
{
    public static void Quality(string directory)
    {
        Directory.CreateDirectory(directory);
        var cases = new Dictionary<string, string> {
            { "en", "Section 14: Termination clause and written notice.\nInvoice ZX-92817 totals 1234.56 euros, payable within thirty days.\nThe tenant must preserve all receipts and signed amendments." },
            { "it", "Articolo 14: Risoluzione anticipata e comunicazione scritta.\nLa fattura ZX-92817 ammonta a 1234,56 euro, da pagare entro trenta giorni.\nIl conduttore conserva ricevute e modifiche firmate del contratto." },
            { "ja", "図書館では科学や歴史についての本を読むことができます。\n金曜日の朝までに書類を返してください。\n契約書には二十ページと最後の署名が含まれています。" }
        };
        var manifest = new List<object>();
        foreach (var item in cases)
        {
            string fontName = item.Key == "ja" ? "Yu Gothic" : "Segoe UI";
            using (var bitmap = new Bitmap(2000, 550))
            using (var graphics = Graphics.FromImage(bitmap))
            using (var font = new Font(fontName, 28))
            {
                graphics.Clear(Color.White);
                graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                graphics.DrawString(item.Value, font, Brushes.Black, new RectangleF(35, 40, 1930, 470));
                bitmap.Save(Path.Combine(directory, item.Key + ".png"), ImageFormat.Png);
                manifest.Add(new { id = item.Key, text = item.Value, image = item.Key + ".png", font = font.Name });
            }
        }
        File.WriteAllText(Path.Combine(directory, "manifest.json"), new JavaScriptSerializer().Serialize(manifest));
    }

    public static void Create(string directory)
    {
        Directory.CreateDirectory(directory);
        var cases = new Dictionary<string, string> {
            { "en", "The library contains books about science and history.\nPlease return the documents before Friday morning.\nThe contract includes twenty pages and a final signature." },
            { "it", "La biblioteca contiene libri di scienza e storia.\nPer favore restituisci i documenti prima di venerdi mattina.\nIl contratto include venti pagine e una firma finale." },
            { "it-accents", "La città è più bella quando c'è il sole.\nPerché l'università aprirà lunedì? Qualità, società e libertà.\nÈ già disponibile il documento aggiornato per l'attività." },
            { "fr", "La bibliothèque contient des livres de science et d'histoire.\nVeuillez retourner les documents avant vendredi matin.\nLe contrat comprend vingt pages et une signature finale." },
            { "de", "Die Bibliothek enthält Bücher über Wissenschaft und Geschichte.\nBitte geben Sie die Dokumente vor Freitagmorgen zurück.\nDer Vertrag enthält zwanzig Seiten und eine Unterschrift." },
            { "es", "La biblioteca contiene libros de ciencia e historia.\nPor favor devuelve los documentos antes del viernes.\nEl contrato incluye veinte páginas y una firma final." },
            { "ru", "В библиотеке есть книги о науке и истории.\nПожалуйста, верните документы до пятницы.\nДоговор содержит двадцать страниц и подпись." },
            { "zh", "图书馆里有科学和历史方面的书籍。\n请在星期五之前归还这些文件。\n合同包括二十页内容和最后的签名。" },
            { "ar", "تحتوي المكتبة على كتب عن العلوم والتاريخ.\nيرجى إعادة المستندات قبل صباح الجمعة.\nيتضمن العقد عشرين صفحة وتوقيعًا نهائيًا." },
            { "mixed-latin", "La città è bella. The library contains history books.\nLa bibliothèque est ouverte. Bücher über Wissenschaft.\nEl contrato incluye veinte páginas y una firma final." }
        };
        var manifest = new List<object>();
        foreach (var item in cases)
        {
            string fontName = item.Key == "zh" ? "Microsoft YaHei" : "Segoe UI";
            string imagePath = Path.Combine(directory, item.Key + ".png");
            using (var bitmap = new Bitmap(2000, 550))
            using (var graphics = Graphics.FromImage(bitmap))
            using (var font = new Font(fontName, 28))
            using (var format = new StringFormat())
            {
                graphics.Clear(Color.White);
                graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                if (item.Key == "ar") format.FormatFlags = StringFormatFlags.DirectionRightToLeft;
                graphics.DrawString(item.Value, font, Brushes.Black, new RectangleF(35, 40, 1930, 470), format);
                bitmap.Save(imagePath, ImageFormat.Png);
                manifest.Add(new { id = item.Key, text = item.Value, image = item.Key + ".png", font = font.Name });
            }
        }
        using (var speech = new SpeechSynthesizer())
        {
            foreach (var info in speech.GetInstalledVoices())
            {
                string lang = info.VoiceInfo.Culture.TwoLetterISOLanguageName;
                if (lang != "it" && lang != "en") continue;
                string text = cases[lang].Replace("\n", " ");
                speech.SelectVoice(info.VoiceInfo.Name);
                speech.Rate = -1;
                speech.SetOutputToWaveFile(Path.Combine(directory, "speech-" + lang + "-original.wav"));
                speech.Speak(text);
                speech.SetOutputToNull();
                File.WriteAllText(Path.Combine(directory, "speech-" + lang + ".txt"), text);
                manifest.Add(new { id = "speech-" + lang, text = text, voice = info.VoiceInfo.Name });
            }
        }
        File.WriteAllText(Path.Combine(directory, "manifest.json"), new JavaScriptSerializer().Serialize(manifest));
    }
}
