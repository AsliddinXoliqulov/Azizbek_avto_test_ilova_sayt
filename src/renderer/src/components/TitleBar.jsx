import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import ThemeToggle from './ThemeToggle'
import {
  IconGlobe,
  IconHome,
  IconLogOut,
  IconUser,
} from './Icons'
import { useLanguage, useUi } from '../i18n'
import darkBrand from '../../../logo-dark.png'
import lightBrand from '../../../logo-light.png'

// Menyu tashqarisiga bosilganda yoki Escape bosilganda yopiladi.
function useDismiss(ref, open, close) {
  useEffect(() => {
    if (!open) return undefined
    const onPointer = (event) => {
      if (!ref.current?.contains(event.target)) close()
    }
    const onKey = (event) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, open, close])
}

export default function TitleBar({
  showLogout = true,
}) {
  const t = useUi()
  const { language, setLanguage } = useLanguage()
  const location = useLocation()
  const navigate = useNavigate()
  const isHome = location.pathname === '/'

  const [profileOpen, setProfileOpen] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const profileRef = useRef(null)
  useDismiss(profileRef, profileOpen, () => setProfileOpen(false))

  const languages = [
    { code: 'uz-Latn', label: 'UZ', title: t('latin') },
    { code: 'uz-Cyrl', label: 'ЎЗ', title: t('cyrillic') },
    { code: 'ru', label: 'RU', title: t('russian') },
  ]
  const currentLanguage =
    languages.find((option) => option.code === language) || languages[0]

  async function selectLanguage(code) {
    await window.api.settings.setLanguage(code)
    setLanguage(code)
  }

  function cycleLanguage() {
    const currentIndex = languages.findIndex(
      (option) => option.code === currentLanguage.code
    )
    const nextLanguage = languages[(currentIndex + 1) % languages.length]
    void selectLanguage(nextLanguage.code)
  }

  async function logout() {
    const confirmed = await confirm({
      title: t('exitApp'),
      message: t('exitConfirm'),
      confirmLabel: t('exitApp'),
      cancelLabel: t('cancel'),
      danger: true,
    })
    if (!confirmed) return

    try {
      setLogoutError('')
      await window.api.activation.logout()
    } catch (reason) {
      setLogoutError(reason.message || String(reason))
    }
  }

  return (
    <header className={`titlebar${isHome ? ' is-home' : ''}`}>
      <div className="titlebar-start">
        <button
          type="button"
          className="brand"
          onClick={() => navigate('/')}
          aria-label={t('mainMenu')}
        >
          <span className="brand-mark">
            <img className="brand-logo-dark" src={darkBrand} alt="" />
            <img className="brand-logo-light" src={lightBrand} alt="" />
          </span>
          <span className="brand-copy">
            <strong>AZIZBEK PRAVA</strong>
            <em>AKADEMIYASI</em>
          </span>
        </button>
      </div>

      <button
        className="titlebar-home-btn"
        type="button"
        onClick={() => navigate('/')}
        disabled={isHome}
        aria-label={t('mainMenu')}
        title={t('mainMenu')}
      >
        <IconHome className="titlebar-home-icon" />
        <span>{t('mainMenu')}</span>
      </button>

      <div className="titlebar-actions">
        <div className="titlebar-menu-wrap profile-wrap" ref={profileRef}>
          <button
            type="button"
            className={`titlebar-profile-btn${profileOpen ? ' is-open' : ''}`}
            onClick={() => setProfileOpen((open) => !open)}
            aria-label={t('profile')}
            aria-expanded={profileOpen}
            aria-haspopup="menu"
            title={t('profile')}
          >
            <span className="titlebar-profile-avatar">
              <IconUser />
            </span>
          </button>
          {profileOpen && (
            <div className="titlebar-popover profile-popover" role="menu">
              {logoutError && (
                <p className="titlebar-popover-note" role="alert">
                  {logoutError}
                </p>
              )}
              <div className="profile-menu-divider" />
              <button
                type="button"
                className="profile-setting-button"
                onClick={cycleLanguage}
                aria-label={`${t('language')}: ${currentLanguage.title}`}
                title={`${t('language')}: ${currentLanguage.title}`}
              >
                <IconGlobe aria-hidden="true" />
                <span>{t('language')}</span>
                <span className="profile-setting-value">
                  {currentLanguage.label}
                </span>
              </button>
              <ThemeToggle menuItem />
              {showLogout && (
                <button
                  type="button"
                  className="profile-setting-button"
                  onClick={() => void logout()}
                  aria-label={t('exitApp')}
                  title={t('exitApp')}
                >
                  <IconLogOut aria-hidden="true" />
                  <span>{t('exitApp')}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
