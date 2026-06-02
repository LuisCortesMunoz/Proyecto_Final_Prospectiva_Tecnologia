// ============================
// SCROLL REVEAL
// ============================
const revealElements = document.querySelectorAll(
  '.about-card, .comp-item, .step, .team-card, .section-title, .section-label'
);

revealElements.forEach(el => el.classList.add('reveal'));

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      setTimeout(() => {
        entry.target.classList.add('visible');
      }, 80);
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

revealElements.forEach(el => observer.observe(el));

// Stagger about cards
document.querySelectorAll('.about-card').forEach((card, i) => {
  card.style.transitionDelay = `${i * 0.12}s`;
});

document.querySelectorAll('.comp-item').forEach((item, i) => {
  item.style.transitionDelay = `${i * 0.07}s`;
});

// ============================
// NAVBAR SCROLL EFFECT
// ============================
const navbar = document.querySelector('.navbar');
window.addEventListener('scroll', () => {
  if (window.scrollY > 50) {
    navbar.style.borderBottomColor = 'rgba(34,201,126,0.3)';
  } else {
    navbar.style.borderBottomColor = 'rgba(34,201,126,0.18)';
  }
});

// ============================
// SMOOTH ACTIVE NAV
// ============================
const sections = document.querySelectorAll('section[id]');
const navLinks = document.querySelectorAll('.nav-links a[href^="#"]');

window.addEventListener('scroll', () => {
  let current = '';
  sections.forEach(sec => {
    if (window.scrollY >= sec.offsetTop - 120) current = sec.id;
  });
  navLinks.forEach(link => {
    link.style.color = '';
    if (link.getAttribute('href') === `#${current}`) {
      link.style.color = 'var(--green-300)';
    }
  });
});

console.log('%c🎙️ VoiceAutoLab — Proyecto Final', 'color:#22c97e;font-size:1.2rem;font-weight:bold;');
