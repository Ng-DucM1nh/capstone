MEASURE_CHOICES = [
    "finalpweight",
    "finalgrowthpbs",
    "methane",
    "animalvalue",
    "animalprod",
    "carcassweight",
    "feedintakekgd",
]

MEASURE_LABELS = {
    "finalpweight": "Final processed weight (kg)",
    "finalgrowthpbs": "Final growth PBS (kg/day)",
    "methane": "Methane production (g/day)",
    "animalvalue": "Animal value ($)",
    "animalprod": "Animal production rate (S/day)",
    "carcassweight": "Carcass weight (kg)",
    "feedintakekgd": "Feed intake (kg/day)",
}

MEASURE_UNITS = {
    "finalpweight": "kg",
    "finalgrowthpbs": "kg/day",
    "methane": "g/day",
    "animalvalue": "$",
    "animalprod": "units",
    "carcassweight": "kg",
    "feedintakekgd": "kg/day",
}

MONTH_NAMES = [
    "All",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
]

CSV_COLUMN_MAP = {
    "eid": "eid",
    "date": "date",
    "breed": "breed",
    "treatment": "treatment",
    "mob": "mob",
    "sex": "sex",
    "weight": "weight",
    "pweight": "pweight",
    "growthpbs": "growthpbs",
    "finalpweight": "finalpweight",
    "finalgrowthpbs": "finalgrowthpbs",
    "finaldailygrowth": "finaldailygrowth",
    "feedintakekgd": "feedintakekgd",
    "feedintakepct": "feedintakepct",
    "methane": "methane",
    "animalvalue": "animalvalue",
    "animalprod": "animalprod",
    "feedintakekgdsum": "feedintakekgdsum",
    "finalgrowthpbssum": "finalgrowthpbssum",
    "animalprodsum": "animalprodsum",
    "methanesum": "methanesum",
    "methanesupplsum": "methanesupplsum",
    "carcassweight": "carcassweight",
    "dressedcarcass": "dressedcarcass",
}
