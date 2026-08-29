// Liste courte et contrôlée (ticket "Présences Coach V1" §4/§23 : "3 boutons
// suffisent"). Pas de "retard" : évalué explicitement pendant l'audit puis
// écarté par décision produit (voir rapport final) faute de précédent le
// justifiant dans ce projet. Jamais accentué (même politique que tous les
// statuts varchar de ce projet : "annule", "envisage", ...).
export const ATTENDANCE_STATUSES = ["present", "absent", "excuse"] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
