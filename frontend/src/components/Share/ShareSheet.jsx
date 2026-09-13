import { useEffect, useRef, useState } from "react";
import { LuCheck, LuLink, LuShare2 } from "react-icons/lu";
import Button from "../ui/Button";
import Modal from "../ui/Modal";
import { useLang } from "../../context/LangContext";
import { useToast } from "../../context/ToastContext";
import { SHARE_CHANNELS, canNativeShare, copyText, nativeShare } from "../../lib/share";
import "./Share.css";

/**
 * ShareSheet — the panel behind <ShareButton>. Built on <Modal>, so the focus
 * trap, Escape, scroll lock, focus return and the phone bottom-sheet treatment
 * are the site's existing ones rather than a second implementation.
 *
 * Opened by <ShareButton>; not exported for direct use.
 */
export default function ShareSheet({ open, onClose, title, text, url }) {
  const { t } = useLang();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const timer = useRef(null);
  const linkRef = useRef(null);

  // "Copied" is a momentary state; a sheet reopened later should not still be
  // claiming it, and the timer must not fire into an unmounted component.
  useEffect(() => {
    if (!open) {
      setCopied(false);
      setCopyFailed(false);
    }
    return () => clearTimeout(timer.current);
  }, [open]);

  const payload = { title, text: text || title, url };

  const handleCopy = async () => {
    const ok = await copyText(url);
    setCopied(ok);
    setCopyFailed(!ok);
    if (ok) {
      toast.success(t("இணைப்பு நகலெடுக்கப்பட்டது.", "Link copied."));
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } else {
      // Nothing was copied, so say so and put the link where it can be copied
      // by hand instead of showing a success the visitor cannot act on.
      linkRef.current?.select();
    }
  };

  const handleNative = async () => {
    const result = await nativeShare(payload);
    if (result === "shared") onClose();
    // "dismissed" is the visitor closing the system sheet — leave ours open so
    // they can pick a channel instead. "failed" falls through to the same.
    if (result === "failed") toast.error(t("பங்கிட முடியவில்லை.", "Your device could not open its share sheet."));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      className="share-sheet"
      eyebrow={t("பங்கிடு", "Share")}
      title={title}
      description={text || undefined}
    >
      {/* The device's own sheet, where there is one. Offered as a choice rather
          than substituted for the list: on a desktop there is no system sheet,
          and on a phone a visitor who wants WhatsApp should not have to go
          through two panels to reach it. */}
      {canNativeShare(payload) && (
        <Button variant="primary" block icon={<LuShare2 aria-hidden="true" />} onClick={handleNative}>
          {t("சாதனம் வழியாக பங்கிடு", "Share with your device")}
        </Button>
      )}

      <ul className="share-grid">
        {SHARE_CHANNELS.map((channel) => {
          const Icon = channel.icon;
          return (
            <li key={channel.id}>
              <Button
                href={channel.href({ url, title, text: text || title })}
                target={channel.newTab ? "_blank" : undefined}
                rel={channel.newTab ? "noopener noreferrer" : undefined}
                variant="soft"
                block
                className={`share-opt share-opt--${channel.id}`}
                icon={<Icon aria-hidden="true" />}
                onClick={onClose}
              >
                {t(channel.label[0], channel.label[1])}
              </Button>
            </li>
          );
        })}
      </ul>

      {/* The link itself, always visible. It is the copy target, and it is also
          the fallback: a browser that refuses both clipboard routes still
          leaves a selectable field. */}
      <div className="share-link">
        <input
          ref={linkRef}
          className="share-link__url"
          type="text"
          readOnly
          value={url}
          aria-label={t("பங்கிடும் இணைப்பு", "Link to share")}
          onFocus={(e) => e.target.select()}
        />
        <Button
          variant="outline"
          className="share-link__btn"
          icon={copied ? <LuCheck aria-hidden="true" /> : <LuLink aria-hidden="true" />}
          onClick={handleCopy}
        >
          {copied ? t("நகலெடுக்கப்பட்டது", "Copied") : t("இணைப்பை நகலெடு", "Copy link")}
        </Button>
      </div>

      {/* One live region for both outcomes, so a screen reader hears the result
          of pressing Copy without the button's own label shifting under it. */}
      <p className="share-note" role="status">
        {copied && t("இணைப்பு நகலெடுக்கப்பட்டது.", "Link copied to your clipboard.")}
        {copyFailed &&
          t(
            "உலாவி நகலெடுக்க அனுமதிக்கவில்லை — மேலே உள்ள இணைப்பைத் தேர்ந்தெடுத்து நகலெடுக்கவும்.",
            "Your browser would not let the page copy for you — the link above is selected, copy it by hand.",
          )}
      </p>
    </Modal>
  );
}
